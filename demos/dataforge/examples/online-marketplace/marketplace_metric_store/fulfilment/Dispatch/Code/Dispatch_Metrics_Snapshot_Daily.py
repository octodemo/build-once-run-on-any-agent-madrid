"""Dispatch daily metrics.

Counts 48-hour dispatch promises met or missed on SNAPSHOT_DATE, by merchant.
Every metric column follows total_{entity}_{verb}_count.

One order is one promise, judged by its first successful dispatch attempt:

- Met: the first attempt with outcome 'dispatched' is at or before
  placed_at + 48 hours. Counted on the day it was dispatched.
- Missed: no successful attempt by placed_at + 48 hours, even if the order
  shipped later. Counted on the day the deadline passed.
- Orders cancelled before their deadline are not counted. Orders cancelled at
  or after their deadline are missed promises.
- Soft-deleted rows (is_deleted = true) are ignored in both source tables.

Globals (SOURCE_ZONE, SNAPSHOT_DATE, SOURCE_CATALOG, TARGET_CATALOG, CADENCE)
are injected by common/daily_runner.py.
"""

GRAIN_KEYS = {
    "Merchant": ["merchant_id"],
}

METRICS = [
    "total_dispatch_meet_count",
    "total_dispatch_miss_count",
]

STATEMENTS = []

for grain, keys in GRAIN_KEYS.items():
    key_list = ", ".join(keys)
    for metric in METRICS:
        STATEMENTS.append(
            f"""
INSERT INTO {TARGET_CATALOG}.Dispatch_{grain}_Metrics_Snapshot_Daily
WITH first_success AS (
    SELECT
        order_id,
        MIN(attempted_at) AS first_dispatched_at
    FROM {SOURCE_CATALOG}.dispatch_attempts
    WHERE is_deleted = false
      AND outcome = 'dispatched'
    GROUP BY order_id
),
dispatch_promises AS (
    SELECT
        o.order_id,
        o.{key_list},
        o.placed_at + INTERVAL 48 HOUR AS deadline_at,
        f.first_dispatched_at
    FROM {SOURCE_CATALOG}.orders AS o
    LEFT JOIN first_success AS f
        ON f.order_id = o.order_id
    WHERE o.is_deleted = false
      AND (
          o.cancelled_at IS NULL
          OR o.cancelled_at >= o.placed_at + INTERVAL 48 HOUR
      )
),
dispatch_events AS (
    SELECT
        {key_list},
        order_id,
        'total_dispatch_meet_count' AS metric_name,
        CAST(first_dispatched_at AS DATE) AS event_date
    FROM dispatch_promises
    WHERE first_dispatched_at <= deadline_at
    UNION ALL
    SELECT
        {key_list},
        order_id,
        'total_dispatch_miss_count' AS metric_name,
        CAST(deadline_at AS DATE) AS event_date
    FROM dispatch_promises
    WHERE first_dispatched_at IS NULL
       OR first_dispatched_at > deadline_at
)
SELECT
    DATE '{SNAPSHOT_DATE}' AS SNAPSHOT_DATE,
    {key_list},
    '{metric}' AS metric_name,
    COUNT(DISTINCT order_id) AS metric_value,
    now() AS LOAD_TIMESTAMP,
    '{SOURCE_ZONE}' AS SOURCE_ZONE
FROM dispatch_events
WHERE metric_name = '{metric}'
  AND event_date = DATE '{SNAPSHOT_DATE}'
GROUP BY {key_list}
"""
        )
