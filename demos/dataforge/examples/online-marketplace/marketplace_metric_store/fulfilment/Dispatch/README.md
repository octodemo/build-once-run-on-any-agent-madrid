# Dispatch

48-hour dispatch promise metrics for the fulfilment domain. Each order counts
once, using its earliest successful dispatch attempt. Soft-deleted rows are
excluded. Orders cancelled before the deadline are excluded from both metrics.

## Metrics

| Metric | Grain | Cadences | Event date | Source |
| --- | --- | --- | --- | --- |
| `total_dispatch_meet_count` | merchant | Daily, Cumulative | First dispatch date | `orders` and `dispatch_attempts` |
| `total_dispatch_miss_count` | merchant | Daily, Cumulative | 48-hour deadline date | `orders` and `dispatch_attempts` |

An order cancelled exactly at the deadline counts as a miss. Daily misses are
final only after the deadline date has ended.

## Development history

| Type | Date | Contributors | Issue | Summary |
| :--- | :--- | :--- | :--- | :--- |
| New Entity | 11/24/2026 | @martalacasta | #9 | Add 48-hour dispatch meet and miss metrics |
