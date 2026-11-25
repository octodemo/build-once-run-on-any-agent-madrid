# Dispatch

48-hour dispatch promise metrics for the fulfilment domain. Every order should
leave a fulfilment centre within 48 hours of being placed.

## Metrics

| Metric | Grains | Cadences | Counted on |
| --- | --- | --- | --- |
| `total_dispatch_meet_count` | merchant | Daily, Cumulative | Day of the first successful dispatch |
| `total_dispatch_miss_count` | merchant | Daily, Cumulative | Day the 48-hour deadline passed |

Sources: `orders` (`merchant_id`, `placed_at`, `cancelled_at`) and
`dispatch_attempts` (`attempted_at`, `outcome`).

## Rules

- One order is one promise, judged by its first attempt with
  `outcome = 'dispatched'`. The deadline is `placed_at + 48 hours`.
- Met: first successful dispatch at or before the deadline.
- Missed: no successful dispatch by the deadline, even if the order shipped
  later.
- Cancelled before the deadline: not counted. Cancelled at or after the
  deadline: missed.
- Soft-deleted rows (`is_deleted = true`) are excluded from both tables.
- Timestamps are Madrid local time and are used as stored.

A missed promise only appears once its deadline date is on or before
`SNAPSHOT_DATE`, so loads should run for completed days (the runner default is
yesterday).

## Development history

| Date | Change | Issue |
| --- | --- | --- |
| 2026-11-25 | Initial build: meet and miss counts at merchant grain | #11 |
