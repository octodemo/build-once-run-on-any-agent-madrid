# Scripted demo: did we keep our 48-hour promise?

One GitHub issue in, one reviewed pull request out. Dataforge's four skills
run, unchanged, inside the GitHub Copilot app. A canvas beside the chat shows
what is happening. The pull request then gets two independent checks:
human-owned acceptance tests and an advisory GitHub Copilot code review,
guided by the repository's `code-review` skill and linked-issue MCP context
when available.

The thing worth watching is not that an agent wrote SQL. It is that four
skills with no knowledge of this business produce marketplace-correct code,
because everything they need to know lives in one manifest and one issue —
and that a person makes exactly two decisions during the build: approve the
design, and approve the deploy. After independent verification and review, a
person still makes the final decision on changes and merging.

## Presenter note: recorded and sped up

The demo is a recording, played sped up. The last rehearsal took about 13
minutes of agent time; quote the time of the run you actually recorded. The two
moments where a person decides — **3 Design** and **7 Deploy** — play at
normal speed.

Say to the audience: *"This is sped up — the real build took about N minutes.
It slows down at the two build approvals. Then we review the pull request."*

## Before you record

You need the GitHub Copilot app, the GitHub CLI signed in with access to
`octodemo/build-once-run-on-any-agent-madrid`, the DuckDB CLI, and Python 3.9+.
Complete the [manual GitHub setup](../../../../README.md#github-setup-manual):
enable Copilot code review and MCP tools for review, confirm issue access, and
keep **Dispatch promise acceptance tests** required. Request review manually
or use an available automatic-review setting; no repository file enables these
settings. Keep review advisory and merging manual.

Run these from the root of your clone of the repository (the folder that
contains `README.md` and `demos/`):

```bash
brew install duckdb                                   # once, if you don't have it
gh repo set-default octodemo/build-once-run-on-any-agent-madrid
cd demos/dataforge/examples/online-marketplace
./reset.sh --yes                                      # builds a fresh warehouse
```

Open the repository as a project in the Copilot app. The repository settings in
`.github/copilot/settings.json` enable Shishir Tewari's Dataforge plugin for
this repository only; it appears under **Customize → Installed** with its four
skills. (To try it without installing anything, use Copilot CLI with
`copilot --plugin-dir demos/dataforge`.)

In a new session, ask Copilot:

> Open the Dataforge canvas.

> Initialize dataforge for the project in demos/dataforge/examples/online-marketplace.

`forge-init` reads the few lines of seed manifest and discovers the rest. It
ends by showing what it learned and asking you to check it — that check is
part of setup, not the recording.

| Discovered from | What it learns |
| --- | --- |
| `warehouse/*.duckdb` | two regions, deployed `east` then `west` |
| `information_schema` | the source tables and their columns |
| `marketplace_metric_store/` | one domain (`fulfilment`), one built entity (`Order`) |
| `Schema/*.sql` file names | one grain (`merchant`), two cadences (daily, cumulative) |
| `Code/*.py` | the naming grammar `total_{entity}_{verb}_count` |

The seed adds what can't be discovered: the verbs `meet` and `miss`, and that
the new Dispatch entity belongs in `fulfilment`.

Then, from the repository root, open the issue:

```bash
gh issue create --repo octodemo/build-once-run-on-any-agent-madrid \
  --title "Track our 48-hour dispatch promise" \
  --body-file demos/dataforge/examples/online-marketplace/issues/dispatch-promise.md \
  --label metric-request
```

Start recording.

## Act 1 — The question

**Canvas: The question.** The marketplace promises that every order leaves a
fulfilment centre within 48 hours. There are two regions, each with its own
warehouse: `east` (Madrid Este) and `west` (Madrid Oeste).

The issue already states the agreed rules — met, missed, cancellations,
retries, test orders — so the agent has nothing to guess. Tell the same three
orders as the slide "Three orders, one promise". Point to them by what
happened, not by number:

- **Dispatched after 29 hours:** promise met.
- **Two failed tries, then dispatched after 68 hours:** promise missed, and it
  counts once, not three times.
- **Cancelled after 4 hours:** not counted at all.

The canvas lists a few more orders (one that never ships, one cancelled too
late, one placed yesterday, a test order). Don't walk through them; say *"the
tests cover a few more cases like these."* The rules on screen are the
human-owned acceptance tests. The agent is never pointed at them.

**Canvas: The build.** Say: *"Before this recording started, Dataforge learned
how this team works and wrote it down in one file."* The manifest box shows
it; `meet` and `miss` came from the manifest, because the business word has to
come from somewhere other than the skills.

## Act 2 — The build

> Build the metrics in issue #N. Run the full pipeline with no questions, but stop for my approval at Phase 3 Design and at Phase 7 Deploy. Include Closes #N in the pull request body.

**1 Scope and 2 Discover** run without stopping (sped up). Every query goes
through `forge-dbx`, which refuses row-level `SELECT *` even against synthetic
data on a laptop. Discovery checks every value in the issue against the data
and shows its report.

### First decision: 3 Design (normal speed)

Dataforge shows the metric design and **stops for approval**: the two metrics,
`total_dispatch_meet_count` and `total_dispatch_miss_count`, which day each is
counted on, and its proof-of-concept counts in both regions. Watch the join
decision: `dispatch_attempts` has several rows for some orders, so it is
reduced to one row per order before it meets `orders`.

> Approved.

**4 Schema, 5 Pipelines and 6 Test** run without stopping (sped up). The new
`Dispatch/` files appear in the canvas, and the agent runs its own tests.

### Second decision: 7 Deploy (normal speed)

Dataforge shows every table definition in full, the order it will deploy in,
and its plan to push a branch and open a pull request — then **stops for
approval**. Nothing has touched a warehouse yet.

> Approve schema changes. Deploy to Madrid Este, then Madrid Oeste, then push the branch and open the pull request.

It deploys to `east`, and only after that succeeds, to `west`, loads the last
30 days, and opens the pull request.

**Canvas: The proof.** The story orders show **Matches the agreed rules**: the
pipeline's numbers equal the answers people wrote down before the build. Each
region shows promises met and missed by merchant.

## Act 3 — Someone else checks the work

### Second demo: independent review

1. Open the **Dataforge-generated PR in the Madrid repository**. Show
   `Closes #N` in its body and follow the link to the original issue. The
   description locates the request; it is not evidence that the code meets it.
2. Show **Dispatch promise acceptance tests** passing for the PR's current
   revision in Checks. They are human-owned business verification. If pending
   or failing, show that honestly; don't narrate a pass.
3. Under **Reviewers**, request **Copilot**, or open its existing code review.
   Show [`.github/skills/code-review/SKILL.md`](../../../../.github/skills/code-review/SKILL.md):
   it asks the independent reviewer to read the issue through the **GitHub MCP
   server** and compare every requirement with the actual changed files/diff.
4. Where exposed, show skill and MCP attribution beneath review comments, or
   open the review session from the PR timeline and inspect its tool logs.
   Only say the skill or issue context was used when the UI/logs provide that
   evidence. Configuration alone does not prove use.
5. Read the actual overview and any inline findings. For each finding shown,
   open the cited file and line in the diff and explain the evidence. Do not
   assume Copilot will find a problem or that an older review covers a new push.
6. Explain: *"The tests check the business results. The reviewer compares the
   implementation with the request and raises concerns. A person decides
   whether anything needs changing."* Leave the PR unmerged for this demo.

| Check | What it is | Role |
| --- | --- | --- |
| **Dispatch promise acceptance tests** | Human-owned tests in `acceptance/`; expected values computed independently from the source data | Required to merge |
| **GitHub Copilot code review** | Independent review of the implementation against the linked issue; can load the `code-review` skill and GitHub MCP context | Advisory |

### Narrate the result you actually get

| Observed outcome | What to say |
| --- | --- |
| No findings | *"This review did not report a problem. That doesn't prove there are no bugs. We still have the business tests and a person's decision."* |
| Findings | *"Here is the requirement, and here is the file and line the reviewer flagged. A person checks whether the concern needs a change."* Do not treat every suggestion as a confirmed defect. |
| Issue context unavailable or use not evidenced | *"We can't verify that this review checked the original request. It can still comment on code, but that part of the review is unverified."* Show the missing link/access/tool evidence; do not substitute the author's summary. |

Copilot may produce inline findings and an overview assessment, not Proof
Agent's PASS/FAIL/PARTIAL format. Review content and skill/MCP selection are not
deterministic. The canvas only reports observed GitHub review metadata and
comments; it cannot establish skill/tool use or whether a requested review is
running. Inspect GitHub for that evidence.

The original Universe talk used Andrea Griffiths' Proof Agent. Its unchanged
[source/demo materials](../../../proof-agent/) remain available for attribution
and historical reference, not as evidence of a current Madrid Copilot review.
This adaptation preserves the independent-review pattern with a different
review surface.

Dataforge also manages the issue: once the pull request is open, it comments on
the issue and may close it as delivered.

## The closing point

- The four skills are the same files Shishir ships for Claude Code and Cursor,
  loaded unchanged into GitHub Copilot.
- Everything this business needs is in one manifest. The skills never mention
  merchants, Madrid or dispatch.
- The canvas is the Copilot-app part. The skills don't know it exists.

## If something goes wrong

| Symptom | What to do |
| --- | --- |
| No `forge-*` skills | Check **Customize → Installed** for Dataforge, or start a new session. |
| It goes past the design without stopping | Say: *"Stop. Show me the Phase 3 design before you write any code."* |
| It stops anywhere else | If it's a business question, say: *"Use the rules in the issue and continue."* If the data contradicts the issue, that's a real finding: read it before you answer. |
| DuckDB says a file is locked | Close any other `duckdb` session on that warehouse. |
| Copilot is unavailable as reviewer | Check organization/repository access and code-review policies using the [setup guide](../../../../README.md#github-setup-manual). Do not replace it with an invented review. |
| Issue or MCP context unavailable | Check `Closes #N` and the MCP review setting/access. Narrate the limitation, then inspect attribution/session logs after a re-review. |
| Canvas says review not observed or unavailable | Open the PR. The canvas reads submitted reviews only and reports API/identity limitations explicitly. |
| Running out of time | Show a recording of an actual Madrid run, clearly identified as recorded. Do not present historical Proof Agent output as a Copilot code review. |

## Reset

```bash
./reset.sh          # shows what it would do
./reset.sh --yes    # does it
```

It rebuilds the warehouse and removes only what a run generates. Issues and
pull requests from earlier runs stay on GitHub; the canvas ignores anything
older than the reset.
