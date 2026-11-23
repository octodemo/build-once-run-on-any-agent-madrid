# Scripted demo: did we keep our 48-hour promise?

One GitHub issue in, one reviewed pull request out. Dataforge's four skills
run, unchanged, inside the GitHub Copilot app. A canvas beside the chat shows
what is happening. The pull request then gets two independent checks:
human-owned acceptance tests and an advisory Proof Agent review.

The thing worth watching is not that an agent wrote SQL. It is that four
skills with no knowledge of this business produce marketplace-correct code,
because everything they need to know lives in one manifest and one issue —
and that a person makes exactly two decisions: approve the design, and approve
the deploy.

## Presenter note: recorded and sped up

The demo is a recording, played sped up. The last rehearsal took about 13
minutes of agent time; quote the time of the run you actually recorded. The two
moments where a person decides — **3 Design** and **7 Deploy** — play at
normal speed.

Say to the audience: *"This is sped up — the real build took about N minutes.
It slows down at the only two moments where a person decides."*

## Before you record

You need the GitHub Copilot app, the GitHub CLI signed in with access to
`octodemo/build-once-run-on-any-agent-madrid`, the DuckDB CLI, and Python 3.9+.

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

> Build the metrics in issue #N. Run the full pipeline with no questions, but stop for my approval at Phase 3 Design and at Phase 7 Deploy.

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

The pull request triggers two checks:

| Check | What it is | Role |
| --- | --- | --- |
| **Dispatch promise acceptance tests** | Human-owned tests in `acceptance/`; expected values computed independently from the source data | Required to merge |
| **Proof Agent review** | Andrea Griffiths' verifier skill, run by GitHub Actions through the Copilot SDK; it reviews the diff, not the agent's own account of it | Advisory |

Proof Agent's verdict is whatever it says on the day: PASS, FAIL or PARTIAL.
Read it out as it is. A person decides whether to merge.

In the Sydney reference rehearsal run, [octodemo/build-once-run-on-any-agent#4](https://github.com/octodemo/build-once-run-on-any-agent/pull/4),
the acceptance tests passed in both regions, and Proof Agent returned **FAIL**:
it flagged that the pipelines insert the runner's date and catalog names into
SQL with f-strings. That is a fair point and a judgement call at the same
time: the values come from the team's own runner, not from users, and the
existing Order pipelines use the same pattern. A reasonable decision is to
merge and raise a follow-up to validate `SNAPSHOT_DATE` in the shared runner.
That is the point of the slide: the tests prove the rules, the AI reviewer
raises concerns, and a person weighs them.

The Sydney two-decision flow was rehearsed from a clean reset with
[octodemo/build-once-run-on-any-agent#10](https://github.com/octodemo/build-once-run-on-any-agent/issues/10):
Dataforge stopped exactly twice, at 3 Design and 7 Deploy, and opened
[octodemo/build-once-run-on-any-agent#11](https://github.com/octodemo/build-once-run-on-any-agent/pull/11)
(closed; rehearsal only). The acceptance tests passed; Proof Agent returned
FAIL on the same f-string point.

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
| Proof Agent posts a timeout | Version 1.1.2 uses the SDK's default 60-second wait. The workflow selects Claude Haiku 5.5, but response times vary. Re-run the job, or show the reference pull request. |
| Proof Agent posts an authorisation error | The organisation must allow Copilot requests from Actions. Show the reference pull request instead. |
| Running out of time | Switch to the recording or [Sydney reference octodemo/build-once-run-on-any-agent#4](https://github.com/octodemo/build-once-run-on-any-agent/pull/4), the completed rehearsal run. |

## Reset

```bash
./reset.sh          # shows what it would do
./reset.sh --yes    # does it
```

It rebuilds the warehouse and removes only what a run generates. Issues and
pull requests from earlier runs stay on GitHub; the canvas ignores anything
older than the reset.
