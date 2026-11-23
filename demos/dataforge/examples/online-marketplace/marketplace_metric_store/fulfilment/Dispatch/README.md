# Dispatch

Dispatch promise metrics for the fulfilment domain, at merchant grain.

| Metric | Daily event date | Cumulative |
| :--- | :--- | :--- |
| `total_dispatch_meet_count` | First successful dispatch on or before the 48-hour deadline | Promises met through the snapshot date |
| `total_dispatch_miss_count` | Deadline reached without a successful dispatch | Promises missed through the snapshot date |

Only the first non-deleted successful attempt counts. Soft-deleted orders and
attempts are excluded, as are orders cancelled before the deadline. A late
dispatch or cancellation does not erase a missed promise. A cancellation at
the deadline is not considered an early cancellation.

The shared runners emit DuckDB SQL for a snapshot date. Each pipeline replaces
that date's rows in a transaction, so reruns do not duplicate results. Execute
the emitted SQL with `duckdb -bail` so an error stops the transaction.

## Development history

| Date | Contributor | Change | Issue |
| :--- | :--- | :--- | :--- |
| 2026-11-23 | GitHub Copilot | Add daily and cumulative dispatch promise metrics | [#5](https://github.com/octodemo/build-once-run-on-any-agent-madrid/issues/5) |
