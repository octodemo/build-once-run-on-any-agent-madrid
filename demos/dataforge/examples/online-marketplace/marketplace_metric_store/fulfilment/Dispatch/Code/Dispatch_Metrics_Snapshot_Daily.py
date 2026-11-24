"""Daily dispatch promise metrics by merchant."""

GRAIN_KEYS = {
    "Merchant": ["merchant_id"],
}

METRICS = {
    "total_dispatch_meet_count": (
        "dispatched_at",
        "dispatched_at IS NOT NULL AND dispatched_at <= deadline_at",
    ),
    "total_dispatch_miss_count": (
        "deadline_at",
        "(dispatched_at IS NULL OR dispatched_at > deadline_at) "
        "AND (cancelled_at IS NULL OR cancelled_at >= deadline_at)",
    ),
}

STATEMENTS = []

for grain, keys in GRAIN_KEYS.items():
    key_list = ", ".join(keys)
    target_table = f"{TARGET_CATALOG}.Dispatch_{grain}_Metrics_Snapshot_Daily"
    STATEMENTS.append(
        f"""
DELETE FROM {target_table}
WHERE SNAPSHOT_DATE = DATE '{SNAPSHOT_DATE}'
  AND SOURCE_ZONE = '{SOURCE_ZONE}'
"""
    )

    for metric, (event_column, metric_filter) in METRICS.items():
        STATEMENTS.append(
            f"""
INSERT INTO {target_table}
WITH first_dispatch AS (
    SELECT
        order_id,
        MIN(attempted_at) AS dispatched_at
    FROM {SOURCE_CATALOG}.dispatch_attempts
    WHERE is_deleted = false
      AND outcome = 'dispatched'
    GROUP BY ALL
),
promises AS (
    SELECT
        o.order_id,
        o.merchant_id,
        o.placed_at + INTERVAL 48 HOUR AS deadline_at,
        o.cancelled_at,
        d.dispatched_at
    FROM {SOURCE_CATALOG}.orders o
    LEFT JOIN first_dispatch d
        ON d.order_id = o.order_id
    WHERE o.is_deleted = false
)
SELECT
    DATE '{SNAPSHOT_DATE}' AS SNAPSHOT_DATE,
    {key_list},
    '{metric}' AS metric_name,
    COUNT(DISTINCT order_id) AS metric_value,
    now() AS LOAD_TIMESTAMP,
    '{SOURCE_ZONE}' AS SOURCE_ZONE
FROM promises
WHERE {metric_filter}
  AND CAST({event_column} AS DATE) = DATE '{SNAPSHOT_DATE}'
GROUP BY {key_list}
"""
        )
