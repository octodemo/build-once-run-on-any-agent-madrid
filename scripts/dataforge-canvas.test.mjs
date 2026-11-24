import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { readPullRequestEvidence } from "../.github/extensions/dataforge-canvas/github.mjs";

const repo = "octodemo/build-once-run-on-any-agent-madrid";
const head = "a".repeat(40);
const review = {
  id: 8, is_copilot_code_review: true, user: { id: 42 }, state: "COMMENTED",
  submitted_at: "2026-11-24T12:00:00Z", commit_id: head,
  body: "Compare the deadline with the issue.", html_url: `https://github.com/${repo}/pull/1#pullrequestreview-8`,
};
const check = { name: "Dispatch promise acceptance tests", status: "completed", conclusion: "success", details_url: "https://github.com/check" };
const comment = {
  user: { id: 42 }, path: "pipeline.py", line: 12, side: "RIGHT", body: "Boundary is excluded.",
  html_url: `https://github.com/${repo}/pull/1#discussion_r9`,
};

async function evidence({ reviews = [[]], comments = [[]], runs = [{ check_runs: [check] }], failure, invalid } = {}) {
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    const endpoint = args.at(-1);
    if (failure && endpoint.includes(failure)) return { ok: false, error: "GitHub HTTP 403" };
    if (invalid && endpoint.includes(invalid)) return { ok: true, stdout: "{}" };
    const data = endpoint.includes("/check-runs?") ? runs : endpoint.includes("/comments?") ? comments : reviews;
    return { ok: true, stdout: JSON.stringify(data) };
  };
  return { ...await readPullRequestEvidence({ repo, number: 1, head, gh }), calls };
}

test("reads submitted Copilot reviews and inline evidence across pages, not author claims", async () => {
  const data = await evidence({
    reviews: [[{ ...review, id: 7, is_copilot_code_review: false, body: "Copilot says PASS" }], [review]],
    comments: [[comment], [{ ...comment, user: { id: 99 }, body: "Author reply", in_reply_to_id: 9 }]],
  });
  assert.equal(data.copilotReview.status, "present");
  assert.equal(data.copilotReview.current, true);
  assert.equal(data.copilotReview.summary, review.body);
  assert.deepEqual(data.copilotReview.findings.map((f) => [f.path, f.line, f.body]), [["pipeline.py", 12, comment.body]]);
  assert.equal(data.acceptance.status, "pass");
  assert.ok(data.calls.every((args) => args[0] === "api" && args.includes("--paginate") && args.includes("--slurp")));
  assert.ok(data.calls.some((args) => args.at(-1).includes(`/commits/${head}/check-runs?`)));
});

test("absent or pending reviews never become a synthetic pass", async () => {
  for (const reviews of [
    [[]],
    [[{ ...review, is_copilot_code_review: false, body: "GitHub Copilot code review: PASS" }]],
    [[{ ...review, state: "PENDING", submitted_at: undefined }]],
  ]) {
    const data = await evidence({ reviews, runs: [{ check_runs: [] }] });
    assert.equal(data.copilotReview.status, "not observed");
    assert.equal(data.acceptance.status, "not observed");
    assert.equal(data.copilotReview.summary, undefined);
  }
});

test("missing identity metadata and API errors are unavailable, not no findings", async () => {
  const unknown = await evidence({ reviews: [[{ ...review, is_copilot_code_review: undefined }]] });
  assert.equal(unknown.copilotReview.status, "unavailable");
  const denied = await evidence({ failure: "/reviews?" });
  assert.equal(denied.copilotReview.status, "unavailable");
  assert.match(denied.copilotReview.error, /403/);
  const malformed = await evidence({ invalid: "/reviews?" });
  assert.equal(malformed.copilotReview.status, "unavailable");
  assert.match(malformed.copilotReview.error, /paginated GitHub data/);
});

test("a real review without findings stays advisory; an unreadable comment list is explicit", async () => {
  const empty = await evidence({ reviews: [[review]] });
  assert.equal(empty.copilotReview.status, "present");
  assert.equal(empty.copilotReview.findingCount, 0);
  const partial = await evidence({ reviews: [[review]], failure: "/comments?" });
  assert.equal(partial.copilotReview.status, "present");
  assert.equal(partial.copilotReview.summary, review.body);
  assert.match(partial.copilotReview.error, /403/);
});

test("newer human reviews do not hide Copilot; stale and unknown revisions are labelled", async () => {
  const stale = await evidence({ reviews: [[
    { ...review, commit_id: "b".repeat(40) },
    { ...review, id: 9, submitted_at: "2026-11-24T13:00:00Z", is_copilot_code_review: false },
  ]] });
  assert.equal(stale.copilotReview.current, false);
  assert.match(stale.copilotReview.label, /earlier revision/);
  const unknown = await evidence({ reviews: [[{ ...review, commit_id: null }]] });
  assert.equal(unknown.copilotReview.current, null);
  assert.match(unknown.copilotReview.label, /revision unknown/);
});

test("acceptance failure and unavailable checks cannot be hidden by a successful check", async () => {
  const failed = await evidence({ runs: [{ check_runs: [check] }, { check_runs: [{ ...check, conclusion: "failure" }] }] });
  assert.equal(failed.acceptance.status, "fail");
  const pending = await evidence({ runs: [{ check_runs: [check, { ...check, status: "in_progress", conclusion: null }] }] });
  assert.equal(pending.acceptance.status, "pending");
  const skipped = await evidence({ runs: [{ check_runs: [{ ...check, conclusion: "skipped" }] }] });
  assert.equal(skipped.acceptance.status, "skipping");
  const denied = await evidence({ failure: "/check-runs?" });
  assert.equal(denied.acceptance.status, "unavailable");
  assert.match(denied.acceptance.error, /403/);
});

test("outdated and file comments retain honest locations and long lists link to the full review", async () => {
  const data = await evidence({
    reviews: [[review]],
    comments: [[
      { ...comment, line: null, original_line: 10 },
      { ...comment, line: null, original_line: null },
      ...Array.from({ length: 20 }, () => comment),
    ]],
  });
  assert.equal(data.copilotReview.findings[0].line, 10);
  assert.equal(data.copilotReview.findings[0].outdated, true);
  assert.equal(data.copilotReview.findings[1].line, null);
  assert.equal(data.copilotReview.findings[1].outdated, false);
  assert.equal(data.copilotReview.findings.length, 20);
  assert.equal(data.copilotReview.findingCount, 22);
});

const html = await readFile(new URL("../.github/extensions/dataforge-canvas/ui.html", import.meta.url), "utf8");
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function ui() {
  const elements = new Map();
  const document = {
    querySelectorAll: () => [],
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, { addEventListener() {} });
      return elements.get(id);
    },
  };
  const renderers = runInNewContext(`${source}\n({ renderProof, renderStatus });`, {
    document, URLSearchParams, location: { search: "" },
    localStorage: { getItem() {}, setItem() {} }, setInterval() {},
    fetch: async () => ({ ok: false }),
  });
  return { ...renderers, elements };
}

test("proof UI escapes remote content and links real checks, review and file-line findings", async () => {
  const data = await evidence({
    reviews: [[{ ...review, body: "<script>claim()</script>" }]],
    comments: [[{ ...comment, body: "<img onerror=claim()>" }]],
  });
  const { renderProof, renderStatus, elements } = ui();
  const s = {
    build: { state: {}, phases: [] },
    proof: { warehouse: { zones: {} }, story: null, github: { pr: { ...data, number: 1, state: "OPEN", url: review.html_url, title: "Dispatch" } } },
  };
  renderProof(s);
  renderStatus(s);
  const proof = elements.get("proof").innerHTML;
  assert.match(proof, /pipeline\.py:12/);
  assert.ok(proof.includes(comment.html_url));
  assert.ok(proof.includes(check.details_url));
  assert.match(proof, /&lt;script&gt;claim\(\)&lt;\/script&gt;/);
  assert.match(proof, /&lt;img onerror=claim\(\)&gt;/);
  assert.doesNotMatch(proof, /<script>|<img onerror|Proof Agent|PASS|PARTIAL/);
  assert.match(proof, /A person decides/);
  assert.equal(elements.get("status").className, "chip live");
});

test("proof UI exposes missing context and check errors instead of showing running or pass", async () => {
  const data = await evidence({ failure: "/check-runs?" });
  const { renderProof, renderStatus, elements } = ui();
  const s = {
    build: { state: {}, phases: [] },
    proof: { warehouse: { zones: {} }, story: null, github: { pr: { ...data, number: 1, state: "OPEN", title: "Dispatch" } } },
  };
  renderProof(s);
  renderStatus(s);
  assert.match(elements.get("proof").innerHTML, /No submitted Copilot code review observed/);
  assert.match(elements.get("proof").innerHTML, /GitHub HTTP 403/);
  assert.match(elements.get("status").textContent, /tests unavailable/);
  assert.doesNotMatch(elements.get("status").textContent, /running|pass/);
});
