# Dataforge canvas

A side panel for the GitHub Copilot app that shows a Dataforge build as it
happens, next to the chat. Ask Copilot: **"Open the Dataforge canvas."**

| View | What it shows | Where it comes from |
| --- | --- | --- |
| **The question** | The GitHub issue, the 48-hour promise, the story orders and the agreed rules | The issue file, the GitHub issue, `acceptance/online-marketplace/story.json` |
| **The build** | The Dataforge diagram from the slide (issue → four skills → pull request, the manifest, the data platform, you), lit up as the agent works: the skill in use, the region being queried, the step it's on, and when it's waiting for you. A one-line "now" banner says the same in plain English. | Copilot session events (skills, tool calls, questions, approvals), forge-builder's build-state file, `dataforge.manifest.resolved.yaml`, `git` |
| **The proof** | Story orders, expected versus the pipeline; met and missed promises by merchant in each region; the PR, human-owned acceptance-test status and GitHub Copilot code review, including summary and inline findings when available | A private copy of each DuckDB warehouse, read-only GitHub API calls through `gh` |

## Ground rules

- **Read-only.** It never writes to the project. It reads a *copy* of each
  warehouse, so it never holds a lock the agent needs.
- **Nothing simulated.** Empty states say what hasn't happened yet. Anything
  older than the last `python seed.py` (a rehearsal's build state, issue or pull
  request) is ignored.
- **Host-specific on purpose.** The Dataforge skills are unchanged and don't
  know this canvas exists. The skills are the portable procedure; the canvas is
  the part that belongs to this host, the Copilot app.

## Review evidence and limits

The Madrid adaptation replaces the active Proof Agent Action with advisory
GitHub Copilot code review. Andrea Griffiths' original Proof Agent materials
remain unchanged under `demos/proof-agent/`.

- Check runs are read for the PR's **head commit**, including failed, pending,
  skipped and cancelled acceptance checks. Missing runs are **not observed**;
  failed API access is **unavailable**, not a pass. Required-check enforcement
  must still be configured in GitHub; the canvas does not inspect rulesets.
- Submitted reviews are identified using GitHub's
  `is_copilot_code_review` metadata, not text matching or an author's claims.
  The latest identified review is shown with its URL, summary, revision match,
  review state and up to 20 inline comments with file/line links. Older-revision
  reviews are labelled; they do not imply the current revision was reviewed.
- Requests and in-progress review sessions are not tracked. **Not observed**
  means no submitted review was identified, not that none was requested.
  If review identity metadata or API access is unavailable, the canvas says
  so and directs the presenter to the PR. Comment-fetch errors remain visible
  even when a summary is available.
- Review text is displayed as escaped text, not executable HTML. Inline comments
  are not treated as confirmed bugs or converted to PASS/FAIL/PARTIAL verdicts.
  No summary/findings returned is not proof of correctness.
- Skill/MCP use and complete issue-requirement coverage are **not inferred**.
  Check comment attribution or review-session logs in GitHub, where exposed.
  Guidance in `.github/skills/code-review/SKILL.md` makes the intent explicit;
  actual context selection and findings are not guaranteed.

Acceptance tests verify expected business results and remain the required demo
check. Copilot code review compares implementation with the linked issue; a
person decides whether findings require a change. See [manual GitHub
setup](../../../README.md#github-setup-manual),
[Copilot review and attribution](https://docs.github.com/en/enterprise-cloud@latest/copilot/how-tos/use-copilot-agents/use-code-review),
and [review API metadata](https://docs.github.com/en/enterprise-cloud@latest/rest/pulls/reviews#list-reviews-for-a-pull-request).

Agent-callable actions: `show_view` (question, build or proof), `refresh`, and
`get_status`.

## Files

| File | Purpose |
| --- | --- |
| `extension.mjs` | Registers the canvas with the Copilot app and listens for skill and tool events |
| `state.mjs` | Builds the canvas state from real artifacts |
| `github.mjs` | Reads head-revision acceptance checks and identified Copilot review evidence |
| `server.mjs` | Loopback-only HTTP server for the page and its state |
| `ui.html` | The page, using the app's theme tokens |
| `preview.mjs` | Serves the canvas outside Copilot: `node .github/extensions/dataforge-canvas/preview.mjs` |

Requires Node.js, the DuckDB CLI and the GitHub CLI. The manifest summary uses
the Ruby that ships with macOS to read YAML; without it, the canvas shows the
manifest as text.

Run the canvas regression tests with `node --test scripts/dataforge-canvas.test.mjs`
from the repository root (also included in `npm test`).
