// Read-only PR evidence. Review identity comes from GitHub metadata, never
// comment text, a display name, or the builder's implementation summary.

function checkBucket(check) {
    if (check.status !== "completed") return "pending";
    if (check.conclusion === "success") return "pass";
    if (["failure", "timed_out", "action_required", "startup_failure"].includes(check.conclusion)) return "fail";
    if (check.conclusion === "cancelled") return "cancel";
    if (["skipped", "neutral"].includes(check.conclusion)) return "skipping";
    return "unavailable";
}

export async function readPullRequestEvidence({ repo, number, head, gh }) {
    async function pages(endpoint, key) {
        const result = await gh(["api", "--paginate", "--slurp", "-H", "X-GitHub-Api-Version: 2026-03-10", endpoint]);
        if (!result.ok) return { error: result.error };
        try {
            const data = JSON.parse(result.stdout);
            if (!Array.isArray(data) || !data.every((page) => Array.isArray(key ? page[key] : page))) {
                throw new Error("Expected paginated GitHub data.");
            }
            return { rows: data.flatMap((page) => key ? page[key] : page) };
        } catch (error) {
            return { error: `Could not read GitHub response: ${error.message}` };
        }
    }

    const [runs, reviews] = await Promise.all([
        pages(`repos/${repo}/commits/${head}/check-runs?per_page=100&filter=latest`, "check_runs"),
        pages(`repos/${repo}/pulls/${number}/reviews?per_page=100`),
    ]);
    const checks = (runs.rows || []).map((c) => ({
        name: c.name, state: c.conclusion || c.status, bucket: checkBucket(c), link: c.details_url,
    }));
    const acceptanceChecks = checks.filter((c) => /acceptance/i.test(c.name));
    const status = runs.error ? "unavailable" : !acceptanceChecks.length ? "not observed"
        : ["fail", "unavailable", "pending", "cancel", "skipping", "pass"].find((bucket) => acceptanceChecks.some((c) => c.bucket === bucket));
    const acceptance = { status, checks: acceptanceChecks, error: runs.error || null };
    let copilotReview = { status: "not observed", label: "No submitted Copilot code review observed", findings: [] };
    const submitted = (reviews.rows || []).filter((r) => r.submitted_at && r.state !== "PENDING");
    const review = submitted.filter((r) => r.is_copilot_code_review === true)
        .sort((a, b) => a.submitted_at.localeCompare(b.submitted_at) || a.id - b.id).at(-1);
    if (reviews.error) {
        copilotReview = { ...copilotReview, status: "unavailable", label: "Copilot code review unavailable", error: reviews.error };
    } else if (review) {
        const comments = await pages(`repos/${repo}/pulls/${number}/reviews/${review.id}/comments?per_page=100`);
        const findings = (comments.rows || []).filter((c) => !c.in_reply_to_id && (
            c.is_copilot_code_review === true ||
            (c.is_copilot_code_review !== false && review.user?.id != null && c.user?.id === review.user.id)
        )).map((c) => ({
            body: c.body, path: c.path, line: c.line ?? c.original_line ?? null,
            side: c.side, outdated: c.line == null && c.original_line != null, url: c.html_url,
        }));
        const current = review.commit_id ? review.commit_id === head : null;
        copilotReview = {
            status: "present",
            label: current === true ? "Review posted for this revision" : current === false ? "Review posted for an earlier revision" : "Review posted; revision unknown",
            current, state: review.state, url: review.html_url, at: review.submitted_at,
            summary: review.body || "", findings: findings.slice(0, 20), findingCount: findings.length,
            error: comments.error || null,
        };
    } else if (submitted.some((r) => typeof r.is_copilot_code_review !== "boolean")) {
        copilotReview = { ...copilotReview, status: "unavailable", label: "Copilot review identity unavailable", error: "GitHub did not identify the review source. Open the PR to inspect reviews." };
    }
    return { checks, acceptance, copilotReview };
}
