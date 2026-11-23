# Copilot instructions for this repository

This repository holds the materials for the talk *Build once, run on any agent*
and one runnable demo.

- The Dataforge demo project is `demos/dataforge/examples/online-marketplace/`.
  Run the Dataforge skills against that project. Its seed manifest is
  `dataforge.manifest.yaml` in that folder, and the resolved manifest belongs
  next to it. The template under `demos/dataforge/assets/` is not this
  project's manifest.
- Issues and pull requests for the demo belong in
  `octodemo/build-once-run-on-any-agent-madrid`, never the upstream repository this
  fork came from.
- Do not modify files under `acceptance/`; they are human-owned checks.
- When a script parses DuckDB output, request an explicit format such as
  `-json` or `-csv`.

## The online-marketplace demo: two decisions for a person

The demo is recorded, and a person makes exactly two decisions in it: approving
the metric design (forge-builder Phase 3) and approving the deployment
(Phase 7). Everything else should run without stopping.

- The GitHub issue and the manifest are the source of truth. The issue states
  the agreed business rules; the seed manifest declares the verbs and the
  domain. Don't ask clarifying questions about them. Phase 2 still checks every
  value in the issue against the data; if the data contradicts the issue, stop
  and say so instead of guessing.
- When the presenter asks to run the full pipeline with no questions, show the
  Phase 2 Data Discovery Report and carry on, as the skill's autonomous mode
  allows. Still stop at the Phase 3 design and wait for approval: the presenter
  asks for that stop explicitly.
- At Phase 7, ask once. Put everything that needs sign-off in one message: the
  zones in deployment order (east, Madrid Este, then west, Madrid Oeste), the
  full SQL of every schema file, and the plan to push the branch and open the
  pull request. One approval covers all of it.
