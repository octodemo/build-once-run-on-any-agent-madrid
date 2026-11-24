// Assembles everything the Dataforge canvas shows, from real artifacts only:
// the issue and story fixture, the resolved manifest, forge-builder's build
// state, files changed in the metric store, read-only copies of the regional
// DuckDB warehouses, and pull request status from GitHub.
//
// No Copilot SDK imports here, so preview.mjs can serve the same state outside
// a Copilot session. Nothing in this file writes to the project.

import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { promisify } from "node:util";
import { readPullRequestEvidence } from "./github.mjs";

const run = promisify(execFile);

export const PHASES = [
    "Intake and scoping",
    "Data discovery",
    "Metric design",
    "Schema architecture",
    "Pipeline code",
    "Testing and validation",
    "Deployment and delivery",
];

export const SKILLS = [
    { name: "forge-init", role: "Learns the project" },
    { name: "forge-dbx", role: "Talks to the warehouse" },
    { name: "forge-lint", role: "Applies the house rules" },
    { name: "forge-builder", role: "Runs the seven phases" },
];

const ACTIVE_WINDOW_MS = 90_000;
// While the agent is working, a node stays lit for this long after its last signal.
const LIT_MS = 45_000;
const SKILL_NODE = { "forge-init": "init", "forge-dbx": "dbx", "forge-lint": "lint", "forge-builder": "builder" };

function clip(text, max) {
    const value = String(text ?? "").replace(/\s+/g, " ").trim();
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// Regions a DuckDB command touches: warehouse/<zone>.duckdb, or a `for zone in a b` loop.
function zonesIn(cmd) {
    const found = new Set([...cmd.matchAll(/warehouse\/([A-Za-z0-9_-]+)\.duckdb/g)].map((m) => m[1]));
    const loop = cmd.match(/for\s+\w+\s+in\s+([A-Za-z0-9_ -]+?)\s*;/);
    if (loop && /\.duckdb/.test(cmd)) for (const zone of loop[1].split(/\s+/)) if (zone) found.add(zone);
    return [...found];
}
const WAREHOUSE_TTL_MS = 5_000;
const GITHUB_TTL_MS = 15_000;
const DUCKDB_ENV = { ...process.env, DUCKDB_AGENT_MODE: "0" };

function safeRead(path) {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return null;
    }
}

function safeDir(path) {
    try {
        return readdirSync(path);
    } catch {
        return [];
    }
}

function mtime(path) {
    try {
        return statSync(path).mtimeMs;
    } catch {
        return 0;
    }
}

async function command(file, args, options = {}) {
    try {
        const { stdout } = await run(file, args, { timeout: 15_000, maxBuffer: 8 * 1024 * 1024, ...options });
        return { ok: true, stdout };
    } catch (error) {
        return { ok: false, error: (error.stderr || error.message || String(error)).toString().trim() };
    }
}

async function yamlToJson(path) {
    const result = await command("/usr/bin/ruby", [
        "-ryaml",
        "-rjson",
        "-e",
        "print JSON.generate(YAML.safe_load(File.read(ARGV[0]), aliases: true))",
        path,
    ]);
    if (!result.ok) return null;
    try {
        return JSON.parse(result.stdout);
    } catch {
        return null;
    }
}

function issueBody(markdown) {
    return (markdown || "").replace(/<!--[\s\S]*?-->/g, "").trim();
}

// Schema and table names are interpolated into SQL, so only plain identifiers
// are accepted, whether they come from config.py or from table names.
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function identifier(name, what) {
    if (typeof name !== "string" || !IDENTIFIER.test(name)) {
        throw new Error(`unexpected ${what} name ${JSON.stringify(String(name).slice(0, 60))}`);
    }
    return name;
}

function catalogNames(configPy) {
    const names = [...(configPy || "").matchAll(/_catalog\("([^"]+)"\)/g)].map((m) => m[1]);
    const pick = (value, fallback) => (IDENTIFIER.test(value || "") ? value : fallback);
    return {
        source: pick(names[0], "demo_gold_commerce"),
        target: pick(names[1], "demo_gold_marketplace_metric_store"),
    };
}

export function createState({ repoRoot, exampleDir }) {
    const storyPath = join(repoRoot, "acceptance", "online-marketplace", "story.json");
    const issuePath = join(exampleDir, "issues", "dispatch-promise.md");
    const seedPath = join(exampleDir, "dataforge.manifest.yaml");
    const resolvedPath = join(exampleDir, "dataforge.manifest.resolved.yaml");
    const warehouseDir = join(exampleDir, "warehouse");

    const skillUse = new Map(SKILLS.map((s) => [s.name, { count: 0, last: 0, source: null }]));
    const activity = [];
    const startedAt = Date.now() - 60_000;
    const requestedView = { name: null, seq: 0 };
    // Live signals from the Copilot session, keyed by diagram node or edge.
    const signals = new Map();
    // Questions and approvals the agent is waiting on, keyed by request id.
    const pending = new Map();
    let busy = false;
    const cache = {
        manifest: { at: 0, value: null },
        warehouse: { at: 0, value: null },
        github: { at: 0, value: null },
    };

    function note(label, kind = "tool") {
        activity.unshift({ at: new Date().toISOString(), kind, label });
        activity.length = Math.min(activity.length, 40);
    }

    function signal(...keys) {
        const at = Date.now();
        for (const key of keys) signals.set(key, at);
    }

    function touchSkill(name, how) {
        const entry = skillUse.get(name);
        if (!entry) return;
        entry.count += 1;
        entry.last = Date.now();
        entry.source = how;
        signal(SKILL_NODE[name]);
    }

    // Called for "skill.invoked" session events.
    function recordSkill(data = {}) {
        if (!skillUse.has(data.name)) return;
        touchSkill(data.name, data.pluginName ? `${data.pluginName} plugin` : "skill");
        note(`${data.name} skill loaded${data.pluginName ? ` from the ${data.pluginName} plugin` : ""}`, "skill");
    }

    // Called for "tool.execution_start" session events. Only short labels are
    // kept; full commands and file contents are never stored.
    function recordTool(data = {}) {
        busy = true;
        const name = String(data.toolName || "");
        const args = data.arguments ?? {};
        const text = typeof args === "string" ? args : JSON.stringify(args);
        const cmd = typeof args.command === "string" ? args.command : "";
        const writes = /^(apply_patch|edit|create|write|str_replace|multi_edit)/.test(name);
        if (name === "skill" && skillUse.has(args.skill)) {
            touchSkill(args.skill, "skill");
            return;
        }
        if (name === "ask_user") {
            pending.set(`tool:${data.toolCallId || "ask"}`, { text: String(args.question || "a question"), at: Date.now() });
            signal("you", "e:you");
            note(`Copilot asked you: ${clip(args.question, 80)}`, "you");
            return;
        }
        const read = text.match(/(forge-(?:init|dbx|lint|builder))\/(?:SKILL\.md|references\/([\w./-]+))/);
        if (read) {
            touchSkill(read[1], "read");
            note(`${read[1]}: read ${read[2] ? `references/${basename(read[2])}` : "SKILL.md"}`);
            return;
        }
        if (/dataforge\.manifest\.resolved\.yaml/.test(text) && !/\bduckdb\b/.test(cmd)) {
            if (writes || />\s*\S*dataforge\.manifest\.resolved\.yaml/.test(cmd)) {
                touchSkill("forge-init", "write");
                signal("manifest", "e:writes", "w:manifest");
                note("forge-init: wrote the manifest");
            } else {
                signal("manifest", "e:configures", "r:manifest");
                note("Read the manifest");
            }
            return;
        }
        if (/\bduckdb\b/.test(cmd)) {
            const zones = zonesIn(cmd);
            touchSkill("forge-dbx", "query");
            signal("platform", "e:dbx", ...zones.map((z) => `zone:${z}`));
            lastZones = zones;
            note(`forge-dbx: DuckDB ${/\b(INSERT|CREATE|DROP|ALTER|DELETE)\b/i.test(cmd) ? "write" : "query"}${zones.length ? ` on ${zones.join(" and ")}` : ""}`);
            return;
        }
        if (/\bgh issue\b/.test(cmd)) {
            signal("issue", "e:issue");
            note(`GitHub: gh issue ${cmd.match(/\bgh issue (\w+)/)?.[1] || ""}`.trim());
            return;
        }
        if (/\bgh pr\b/.test(cmd) || /\bgit push\b/.test(cmd)) {
            signal("pr", "e:pr");
            note(/\bgit push\b/.test(cmd) ? "Pushed the branch" : `GitHub: gh pr ${cmd.match(/\bgh pr (\w+)/)?.[1] || ""}`.trim());
            return;
        }
        if (/\bgh label\b/.test(cmd)) {
            note("GitHub: gh label");
            return;
        }
        if (/verify\.py/.test(cmd)) {
            touchSkill("forge-builder", "checkpoint");
            note(`forge-builder: checkpoint check (${cmd.match(/verify\.py\s+([\w-]+)/)?.[1] || "verify"})`);
            return;
        }
        if (/_runner\.py/.test(cmd)) {
            signal("builder");
            note("forge-builder: rendered the pipeline SQL");
            return;
        }
        if (writes && /marketplace_metric_store\//.test(text)) {
            const path = text.match(/marketplace_metric_store\/[\w./-]+/)?.[0];
            signal("builder");
            note(`forge-builder: wrote ${path ? basename(path) : "a pipeline file"}`);
        }
    }

    // Called for other session events: questions, approvals and turns.
    function recordEvent(type, data = {}) {
        if (type === "assistant.turn_start") {
            busy = true;
        } else if (type === "session.idle") {
            busy = false;
        } else if (type === "user_input.requested") {
            pending.set(`input:${data.requestId}`, { text: String(data.question || "a question"), at: Date.now() });
            signal("you", "e:you");
        } else if (type === "user_input.completed") {
            for (const key of [...pending.keys()]) if (key.startsWith("input:") || key.startsWith("tool:")) pending.delete(key);
            note("You answered", "you");
        } else if (type === "permission.requested") {
            const kind = data.permissionRequest?.kind;
            pending.set(`perm:${data.requestId}`, { text: kind ? `approve a ${kind} request` : "approve a request", at: Date.now() });
            signal("you", "e:you");
        } else if (type === "permission.completed") {
            pending.delete(`perm:${data.requestId}`);
        } else if (type === "tool.execution_complete") {
            pending.delete(`tool:${data.toolCallId}`);
        }
    }

    let lastZones = [];

    function requestView(name) {
        requestedView.name = name;
        requestedView.seq += 1;
    }

    async function manifest(force) {
        const stamp = mtime(resolvedPath);
        if (!force && cache.manifest.value && cache.manifest.at === stamp) return cache.manifest.value;
        const raw = safeRead(resolvedPath);
        if (!raw) {
            const value = { exists: false };
            cache.manifest = { at: stamp, value };
            return value;
        }
        const parsed = await yamlToJson(resolvedPath);
        const seed = (await yamlToJson(seedPath)) || {};
        const added = seed?.overrides?.naming?.verbs || [];
        let facts = null;
        if (parsed) {
            const zones = parsed.platform?.zones?.map((z) => z.id) || [];
            facts = {
                engine: parsed.platform?.engine,
                deploymentOrder: parsed.platform?.deployment_order || zones,
                sources: (parsed.catalogs?.sources || []).map((c) => c.pattern),
                targets: (parsed.catalogs?.targets || []).map((c) => c.pattern),
                domains: Object.entries(parsed.domains || {}).map(([name, d]) => ({ name, entities: d?.tools || [] })),
                grains: Object.entries(parsed.grains || {}).map(([name, g]) => ({ name, columns: g?.columns || [] })),
                cadences: parsed.cadences?.length
                    ? parsed.cadences
                    : [
                          (parsed.entity_structure?.daily_suffix || parsed.runner?.daily) && "Daily",
                          (parsed.entity_structure?.cumulative_suffix || parsed.runner?.cumulative) && "Cumulative",
                      ].filter(Boolean),
                metricPattern: parsed.naming?.metric_pattern,
                verbs: (parsed.naming?.verbs || []).map((v) => ({ verb: v, fromManifest: added.includes(v) })),
                unsupported: [
                    parsed.orchestration?.supported === false ? `Scheduling: ${parsed.orchestration.unsupported_reason || "not supported"}` : null,
                    parsed.source_metadata?.version_history?.enabled === false
                        ? `Table history: ${parsed.source_metadata.version_history.unsupported_reason || "not supported"}`
                        : null,
                ].filter(Boolean),
            };
        }
        const generated = raw.match(/^#\s*Generated:\s*(.+)$/m)?.[1]?.trim() || null;
        const value = { exists: true, path: relative(repoRoot, resolvedPath), generated, facts, raw };
        cache.manifest = { at: stamp, value };
        return value;
    }

    function storeDomains() {
        const store = join(exampleDir, "marketplace_metric_store");
        return safeDir(store).filter((d) => d !== "common" && !d.startsWith(".") && !d.includes("."));
    }

    function buildStateDirs() {
        const dirs = [
            join(exampleDir, ".build-state"),
            join(exampleDir, "skills", "forge-builder", ".build-state"),
            join(repoRoot, "demos", "dataforge", "skills", "forge-builder", ".build-state"),
            join(repoRoot, ".build-state"),
        ];
        const installed = join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), "installed-plugins");
        for (const market of safeDir(installed)) {
            for (const plugin of safeDir(join(installed, market))) {
                dirs.push(join(installed, market, plugin, "skills", "forge-builder", ".build-state"));
            }
        }
        return dirs;
    }

    function anchor() {
        // A run starts when seed.py rebuilds the warehouse: its files' creation
        // time marks the start, so leftovers from a rehearsal are ignored even
        // after the app restarts.
        const births = safeDir(warehouseDir)
            .filter((f) => f.endsWith(".duckdb"))
            .map((f) => {
                try {
                    return statSync(join(warehouseDir, f)).birthtimeMs;
                } catch {
                    return 0;
                }
            })
            .filter(Boolean);
        return births.length ? Math.min(...births) - 5_000 : startedAt;
    }

    function buildState() {
        const domains = new Set(storeDomains());
        const since = anchor();
        let best = null;
        for (const dir of buildStateDirs()) {
            for (const file of safeDir(dir)) {
                if (!file.endsWith(".json")) continue;
                const path = join(dir, file);
                const when = mtime(path);
                if (when < since || (best && when <= best.when)) continue;
                try {
                    const data = JSON.parse(readFileSync(path, "utf8"));
                    if (data.domain && domains.size && !domains.has(data.domain)) continue;
                    best = { path, when, data };
                } catch {
                    // A half-written file: ignore it until the next poll.
                }
            }
        }
        if (!best) return { found: false };
        const d = best.data;
        return {
            found: true,
            path: best.path.startsWith(repoRoot) ? relative(repoRoot, best.path) : best.path.replace(homedir(), "~"),
            buildId: d.build_id,
            tool: d.folder_name || d.tool_name,
            issue: d.issue_number || null,
            status: d.status,
            currentPhase: d.current_phase ?? null,
            completed: Array.isArray(d.completed_phases) ? d.completed_phases : [],
            metrics: (Array.isArray(d.metrics) ? d.metrics : []).map((m) => ({ name: m.name, status: m.status })),
            deployment: d.deployment || {},
            branch: d.branch || null,
            prUrl: d.pr_url || null,
            blocking: d.blocking || null,
            updatedAt: d.updated_at || null,
        };
    }

    function phases(state) {
        const done = new Set(state.found ? state.completed : []);
        const current = state.found ? state.currentPhase : null;
        return PHASES.map((name, i) => {
            const n = i + 1;
            let status = "pending";
            if (done.has(n)) status = "done";
            else if (current === n || (state.found && !done.has(n) && done.has(n - 1) && state.status !== "completed")) status = "current";
            if (status === "current" && state.blocking) status = "waiting";
            return { n, name, status };
        });
    }

    async function changedFiles() {
        const rel = relative(repoRoot, exampleDir);
        const files = new Map();
        const base = await command("git", ["merge-base", "HEAD", "origin/main"], { cwd: repoRoot });
        if (base.ok) {
            const diff = await command("git", ["diff", "--name-status", base.stdout.trim(), "--", rel], { cwd: repoRoot });
            if (diff.ok) {
                for (const line of diff.stdout.split("\n").filter(Boolean)) {
                    const [code, path] = line.split("\t");
                    files.set(path, code.startsWith("A") ? "added" : "changed");
                }
            }
        }
        const status = await command("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", rel], { cwd: repoRoot });
        if (status.ok) {
            for (const line of status.stdout.split("\n").filter(Boolean)) {
                const code = line.slice(0, 2);
                const path = line.slice(3);
                files.set(path, code.includes("?") || code.includes("A") ? "added" : "changed");
            }
        }
        return [...files.entries()]
            .filter(([path]) => !path.includes("/warehouse/") && !path.endsWith(".duckdb"))
            .map(([path, change]) => ({ path: relative(rel, path) || path, change, when: mtime(join(repoRoot, path)) }))
            .sort((a, b) => b.when - a.when)
            .slice(0, 30);
    }

    async function duckJson(db, sql) {
        return new Promise((resolve) => {
            const child = execFile("duckdb", ["-json", db], { env: DUCKDB_ENV, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
                if (error) return resolve({ ok: false, error: (stderr || error.message).toString().trim() });
                const text = stdout.trim();
                try {
                    resolve({ ok: true, rows: text ? JSON.parse(text) : [] });
                } catch (parseError) {
                    resolve({ ok: false, error: String(parseError) });
                }
            });
            child.stdin.end(sql);
        });
    }

    async function warehouse(force, story, newEntityHint) {
        if (!force && cache.warehouse.value && Date.now() - cache.warehouse.at < WAREHOUSE_TTL_MS) return cache.warehouse.value;
        const { source, target } = catalogNames(safeRead(join(exampleDir, "marketplace_metric_store", "common", "config.py")));
        const zones = safeDir(warehouseDir).filter((f) => f.endsWith(".duckdb")).map((f) => f.replace(/\.duckdb$/, "")).sort();
        const result = { zones: {}, built: zones.length > 0 };
        for (const zone of zones) {
            // Read a private copy so the canvas never holds a lock on a file the
            // agent may be writing to.
            const tmp = mkdtempSync(join(tmpdir(), "dataforge-canvas-"));
            const copy = join(tmp, `${zone}.duckdb`);
            try {
                copyFileSync(join(warehouseDir, `${zone}.duckdb`), copy);
                if (existsSync(join(warehouseDir, `${zone}.duckdb.wal`))) copyFileSync(join(warehouseDir, `${zone}.duckdb.wal`), `${copy}.wal`);
                const tables = await duckJson(copy, `SELECT table_name FROM information_schema.tables WHERE table_schema = '${target}' ORDER BY 1;`);
                if (!tables.ok) throw new Error(tables.error);
                const entities = [
                    ...new Set(
                        tables.rows
                            .map((r) => r.table_name.match(/^(.+)_Merchant_Metrics_Snapshot_(Daily|Cumulative)$/)?.[1])
                            .filter((name) => name && IDENTIFIER.test(name)),
                    ),
                ];
                const newEntities = entities.filter((e) => e !== "Order");
                const zoneInfo = { available: true, entities, newEntities, merchants: [], story: null, latest: null };
                const entity = newEntities.includes(newEntityHint) ? newEntityHint : newEntities[0];
                if (entity) {
                    const cumulative = `${identifier(target, "schema")}."${identifier(entity, "entity")}_Merchant_Metrics_Snapshot_Cumulative"`;
                    const latest = await duckJson(
                        copy,
                        `SELECT CAST(MAX(SNAPSHOT_DATE) AS VARCHAR) AS d, COUNT(DISTINCT SNAPSHOT_DATE) AS days FROM ${cumulative};`,
                    );
                    const rows = await duckJson(
                        copy,
                        `SELECT m.merchant_name, t.merchant_id, t.metric_name, t.metric_value
                         FROM ${cumulative} t JOIN ${source}.merchants m USING (merchant_id)
                         WHERE t.SNAPSHOT_DATE = (SELECT MAX(SNAPSHOT_DATE) FROM ${cumulative})
                         ORDER BY 1, 3;`,
                    );
                    if (latest.ok) zoneInfo.latest = { date: latest.rows[0]?.d || null, days: latest.rows[0]?.days || 0, entity };
                    if (rows.ok) {
                        const byMerchant = new Map();
                        for (const row of rows.rows) {
                            const entry = byMerchant.get(row.merchant_id) || { merchantId: row.merchant_id, name: row.merchant_name, metrics: {} };
                            entry.metrics[row.metric_name] = row.metric_value;
                            byMerchant.set(row.merchant_id, entry);
                        }
                        zoneInfo.merchants = [...byMerchant.values()];
                    }
                    if (story && zone === story.merchant.zone) {
                        const daily = `${identifier(target, "schema")}."${identifier(entity, "entity")}_Merchant_Metrics_Snapshot_Daily"`;
                        const lastDay = await duckJson(copy, `SELECT CAST(CAST(MAX(placed_at) AS DATE) AS VARCHAR) AS d FROM ${source}.orders;`);
                        const storyRows = await duckJson(
                            copy,
                            `SELECT CAST(SNAPSHOT_DATE AS VARCHAR) AS d, metric_name, metric_value FROM ${daily}
                             WHERE merchant_id = ${Number(story.merchant.merchant_id)} ORDER BY 1, 2;`,
                        );
                        if (lastDay.ok && storyRows.ok && lastDay.rows[0]?.d) {
                            const end = new Date(`${lastDay.rows[0].d}T00:00:00Z`);
                            const actual = {};
                            for (const row of storyRows.rows) {
                                const day = 7 - Math.round((end - new Date(`${row.d}T00:00:00Z`)) / 86_400_000);
                                if (day < 1 || day > 7) continue;
                                actual[row.metric_name] = actual[row.metric_name] || {};
                                actual[row.metric_name][String(day)] = (actual[row.metric_name][String(day)] || 0) + row.metric_value;
                            }
                            zoneInfo.story = { actual, loadedDays: storyRows.rows.length };
                        }
                    }
                }
                result.zones[zone] = zoneInfo;
            } catch (error) {
                result.zones[zone] = { available: false, note: `Could not read a copy of ${zone}.duckdb yet (${String(error.message || error).slice(0, 120)}). Retrying.` };
            } finally {
                rmSync(tmp, { recursive: true, force: true });
            }
        }
        cache.warehouse = { at: Date.now(), value: result };
        return result;
    }

    function repoSlug() {
        const seed = safeRead(seedPath) || "";
        return seed.match(/^\s*repository:\s*"?([\w.-]+\/[\w.-]+)"?\s*$/m)?.[1] || null;
    }

    async function github(force, state, story) {
        if (!force && cache.github.value && Date.now() - cache.github.at < GITHUB_TTL_MS) return cache.github.value;
        const repo = repoSlug();
        const value = { repo, issue: null, pr: null, error: null };
        if (!repo) {
            value.error = "No repository is set in the manifest.";
            cache.github = { at: Date.now(), value };
            return value;
        }
        const since = anchor();
        const gh = (args) => command("gh", args, { cwd: repoRoot });
        const parse = (result) => {
            if (!result.ok) {
                value.error = result.error;
                return null;
            }
            try {
                return JSON.parse(result.stdout);
            } catch (error) {
                value.error = `Could not read GitHub response: ${error.message}`;
                return null;
            }
        };

        const issueNumber = state.found && state.issue ? String(state.issue) : null;
        if (issueNumber) {
            value.issue = parse(await gh(["issue", "view", issueNumber, "-R", repo, "--json", "number,title,url,state"]));
        } else {
            // Before forge-builder records the issue, only show one created
            // since the warehouse was last reset, so a rehearsal issue never appears.
            const title = story?.issueTitle || "48-hour dispatch promise";
            const issues = parse(await gh(["issue", "list", "-R", repo, "--state", "all", "--search", `${title} in:title`, "--json", "number,title,url,state,createdAt", "--limit", "10"])) || [];
            value.issue = issues.filter((i) => Date.parse(i.createdAt) >= since).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
        }

        let prNumber = state.found && state.prUrl ? state.prUrl.match(/\/pull\/(\d+)/)?.[1] : null;
        if (!prNumber && state.found && state.branch) {
            const prs = parse(await gh(["pr", "list", "-R", repo, "--state", "all", "--head", state.branch, "--json", "number,createdAt", "--limit", "5"])) || [];
            prNumber = prs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.number?.toString() || null;
        }
        if (!prNumber) {
            const prs = parse(await gh(["pr", "list", "-R", repo, "--state", "all", "--search", "dispatch in:title", "--json", "number,createdAt", "--limit", "10"])) || [];
            prNumber = prs.filter((p) => Date.parse(p.createdAt) >= since).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.number?.toString() || null;
        }
        if (prNumber) {
            const pr = parse(await gh(["pr", "view", prNumber, "-R", repo, "--json", "number,title,url,state,headRefName,headRefOid,isDraft"]));
            if (pr) {
                value.pr = {
                    ...pr,
                    ...await readPullRequestEvidence({ repo, number: prNumber, head: pr.headRefOid, gh }),
                };
            }
        }
        cache.github = { at: Date.now(), value };
        return value;
    }

    function diagram({ state, steps, manifestInfo, warehouseInfo, githubInfo }) {
        const now = Date.now();
        const lit = (key) => busy && signals.has(key) && now - signals.get(key) < LIT_MS;
        const uses = (name) => skillUse.get(name)?.count || 0;
        const waits = [...pending.values()].sort((a, b) => a.at - b.at);
        const waiting = waits.length ? waits[waits.length - 1].text : state.found && state.blocking ? String(state.blocking) : null;
        const building = state.found && ["intake_started", "in_progress", "blocked"].includes(state.status);
        const completed = state.found && state.status === "completed";
        const current = steps.find((p) => p.status === "current" || p.status === "waiting");
        const issue = githubInfo.issue;
        const pr = githubInfo.pr;
        const tests = pr?.acceptance.status || "not observed";
        const review = pr?.copilotReview;
        const facts = manifestInfo.exists ? manifestInfo.facts : null;
        const zoneIds = Object.keys(warehouseInfo.zones || {});
        const deployed = (zone) =>
            (state.found && state.deployment?.[zone] === "success") || (warehouseInfo.zones?.[zone]?.newEntities?.length || 0) > 0;
        const helper = (name, idle) => {
            const node = SKILL_NODE[name];
            const count = uses(name);
            return { state: lit(node) ? "active" : count ? "used" : "idle", sub: idle, uses: count };
        };

        const nodes = {
            you: { state: waiting ? "waiting" : "idle", sub: waiting ? `waiting: ${clip(waiting, 70)}` : "approve design, then deploy" },
            issue: {
                state: lit("issue") ? "active" : issue || state.issue ? "done" : "idle",
                title: issue ? `GitHub issue #${issue.number}` : state.issue ? `GitHub issue #${state.issue}` : "GitHub issue",
                sub: issue ? clip(issue.title, 24) : "a business request",
            },
            builder: {
                state: state.found && state.blocking ? "waiting" : lit("builder") || (busy && building) ? "active" : completed ? "done" : building ? "progress" : "idle",
                sub: current ? `Step ${current.n} of 7 · ${current.name}` : completed ? "all seven steps done" : "runs the job in seven steps",
            },
            init: {
                state: lit("init") ? "active" : manifestInfo.exists ? "done" : "idle",
                sub: manifestInfo.exists ? "learned your project" : "learns your project",
            },
            lint: helper("forge-lint", "applies your standards"),
            dbx: helper("forge-dbx", "runs every query"),
            platform: {
                state: lit("platform") ? "active" : zoneIds.some(deployed) ? "done" : "idle",
                sub: facts?.engine === "duckdb" ? "DuckDB" : "Databricks or DuckDB",
                zones: zoneIds.map((zone) => ({ id: zone, state: lit(`zone:${zone}`) ? "active" : deployed(zone) ? "done" : "idle" })),
            },
            manifest: {
                state: lit("manifest") ? "active" : manifestInfo.exists ? "done" : "idle",
                sub: facts
                    ? clip([facts.deploymentOrder.join(" → "), facts.grains.map((g) => g.name).join(", "), facts.verbs.filter((v) => v.fromManifest).map((v) => v.verb).join(", ")].filter(Boolean).join(" · "), 40)
                    : "your business, in one file",
            },
            pr: {
                state: lit("pr") ? "active" : pr ? (tests === "pending" ? "progress" : "done") : "idle",
                title: pr ? `Pull request #${pr.number}` : "Pull request",
                lines: pr
                    ? [
                          { text: `tests: ${tests}`, tone: tests === "pass" ? "good" : tests === "fail" ? "bad" : "muted" },
                          { text: `Copilot review: ${review?.status || "unavailable"}`, tone: "muted" },
                      ]
                    : [{ text: "code + tests, for review", tone: "muted" }],
            },
        };
        const skillActive = ["builder", "init", "lint", "dbx"].some((n) => nodes[n].state === "active");
        nodes.box = { state: skillActive ? "active" : nodes.builder.state === "waiting" ? "waiting" : building ? "progress" : completed ? "done" : "idle" };

        const edge = (key, done) => (lit(key) ? "active" : done ? "done" : "idle");
        const edges = {
            issue: edge("e:issue", nodes.issue.state === "done" && (building || completed)),
            you: waiting ? "waiting" : "idle",
            pr: edge("e:pr", Boolean(pr)),
            dbx: edge("e:dbx", nodes.platform.state === "done"),
            writes: edge("e:writes", manifestInfo.exists),
            configures: edge("e:configures", manifestInfo.exists),
        };

        // One plain-English sentence for what is happening now.
        let now_ = null;
        if (waiting) {
            now_ = { tone: "waiting", text: `Waiting for you: ${clip(waiting, 110)}` };
        } else {
            const keys = ["init", "lint", "dbx", "builder", "manifest", "issue", "pr"].filter((k) => lit(k));
            const latest = keys.sort((a, b) => signals.get(b) - signals.get(a))[0];
            const step = current ? `forge-builder · step ${current.n} of 7: ${current.name}` : "forge-builder is working";
            const sentences = {
                init: "forge-init is learning the project",
                lint: "forge-lint is applying the team's standards",
                dbx: `forge-dbx is querying ${lastZones.length ? `the ${lastZones.join(" and ")} warehouse${lastZones.length > 1 ? "s" : ""}` : "the warehouse"}`,
                builder: step,
                manifest: signals.get("w:manifest") >= (signals.get("r:manifest") || 0) ? "forge-init is writing the manifest: the business, in one file" : "Reading the manifest: the business, in one file",
                issue: issue ? `Reading GitHub issue #${issue.number}` : "Working with the GitHub issue",
                pr: "Opening the pull request",
            };
            if (latest) now_ = { tone: "active", text: sentences[latest] };
            else if (building) now_ = { tone: "active", text: current ? `forge-builder · step ${current.n} of 7: ${current.name}` : "forge-builder is working" };
            else if (pr) now_ = { tone: tests === "fail" ? "bad" : "idle", text: `Pull request #${pr.number} · tests ${tests} · GitHub Copilot code review: ${review?.status || "unavailable"} · a person decides` };
            else if (completed) now_ = { tone: "done", text: "Build complete" };
            else if (manifestInfo.exists) now_ = { tone: "idle", text: "Dataforge has learned the project. Next: build the metrics in the issue." };
            else if (warehouseInfo.built) now_ = { tone: "idle", text: "Ready. Ask Copilot to initialize dataforge." };
            else now_ = { tone: "idle", text: "Run ./reset.sh --yes to build the warehouses." };
        }
        return { now: now_, nodes, edges };
    }

    async function snapshot({ force = false } = {}) {
        const storyRaw = safeRead(storyPath);
        const story = storyRaw ? JSON.parse(storyRaw) : null;
        const issueMd = safeRead(issuePath);
        if (story) story.issueTitle = "Track our 48-hour dispatch promise";
        const state = buildState();
        const [manifestInfo, files, warehouseInfo, githubInfo] = await Promise.all([
            manifest(force),
            changedFiles(),
            warehouse(force, story, state.found ? state.tool : null),
            github(force, state, story),
        ]);
        const now = Date.now();
        const steps = phases(state);
        const skills = SKILLS.map((s) => {
            const use = skillUse.get(s.name);
            return { ...s, uses: use.count, last: use.last || null, active: use.last > 0 && now - use.last < ACTIVE_WINDOW_MS, how: use.source };
        });
        return {
            generatedAt: new Date().toISOString(),
            project: { name: basename(exampleDir), path: relative(repoRoot, exampleDir) },
            requestedView: { ...requestedView },
            question: { issue: { body: issueBody(issueMd), live: githubInfo.issue }, story },
            build: {
                skills,
                manifest: manifestInfo,
                state,
                phases: steps,
                diagram: diagram({ state, steps, manifestInfo, warehouseInfo, githubInfo }),
                files,
                activity: activity.slice(0, 12),
            },
            proof: { warehouse: warehouseInfo, github: githubInfo, story },
        };
    }

    async function summary() {
        const s = await snapshot({ force: true });
        const st = s.build.state;
        const current = s.build.phases.find((p) => p.status === "current" || p.status === "waiting");
        const lines = [
            `Now: ${s.build.diagram.now.text}.`,
            st.found
                ? `Build ${st.buildId}: ${st.status}. ${current ? `Phase ${current.n} of 7 (${current.name})${current.status === "waiting" ? ", waiting for a person" : ""}.` : "All phases complete."}`
                : "No forge-builder build state yet.",
            s.build.manifest.exists ? `Resolved manifest present (${s.build.manifest.path}).` : "No resolved manifest yet: run forge-init.",
            `Files changed in the example: ${s.build.files.length}.`,
            s.proof.github.pr
                ? `PR #${s.proof.github.pr.number} (${s.proof.github.pr.state}); acceptance tests: ${s.proof.github.pr.acceptance.status}; GitHub Copilot code review: ${s.proof.github.pr.copilotReview.label}.`
                : s.proof.github.error ? `GitHub unavailable: ${s.proof.github.error}` : "No pull request yet.",
        ];
        return lines.join("\n");
    }

    return { snapshot, summary, recordSkill, recordTool, recordEvent, requestView };
}
