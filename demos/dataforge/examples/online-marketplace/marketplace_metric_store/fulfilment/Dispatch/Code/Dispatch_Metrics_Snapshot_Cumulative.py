"""Count dispatch promises by merchant through the snapshot date."""

from datetime import date
import re

snapshot_date = date.fromisoformat(SNAPSHOT_DATE).isoformat()
source_zone = SOURCE_ZONE.replace("'", "''")
for catalog in (SOURCE_CATALOG, TARGET_CATALOG):
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", catalog):
        raise ValueError(f"Invalid catalog identifier: {catalog!r}")

METRICS = {
    "total_dispatch_meet_count": (
        "first_dispatched_at",
        "first_dispatched_at <= deadline_at",
    ),
    "total_dispatch_miss_count": (
        "deadline_at",
        "(first_dispatched_at IS NULL OR first_dispatched_at > deadline_at)",
    ),
}

table = f"{TARGET_CATALOG}.Dispatch_Merchant_Metrics_Snapshot_Cumulative"
STATEMENTS = [
    "BEGIN TRANSACTION",
    f"DELETE FROM {table} WHERE SNAPSHOT_DATE = DATE '{snapshot_date}'",
]

for metric, (event_column, condition) in METRICS.items():
    STATEMENTS.append(
        f"""
INSERT INTO {table}
WITH first_success AS (
    SELECT order_id, MIN(attempted_at) AS first_dispatched_at
    FROM {SOURCE_CATALOG}.dispatch_attempts
    WHERE is_deleted = false AND outcome = 'dispatched'
    GROUP BY order_id
),
promises AS (
    SELECT o.order_id, o.merchant_id, o.cancelled_at,
           o.placed_at + INTERVAL '48 hours' AS deadline_at,
           s.first_dispatched_at
    FROM {SOURCE_CATALOG}.orders o
    LEFT JOIN first_success s ON s.order_id = o.order_id
    WHERE o.is_deleted = false
)
SELECT DATE '{snapshot_date}' AS SNAPSHOT_DATE,
       merchant_id,
       '{metric}' AS metric_name,
       COUNT(DISTINCT order_id) AS metric_value,
       now() AS LOAD_TIMESTAMP,
       '{source_zone}' AS SOURCE_ZONE
FROM promises
WHERE (cancelled_at IS NULL OR cancelled_at >= deadline_at)
  AND {condition}
  AND CAST({event_column} AS DATE) <= DATE '{snapshot_date}'
GROUP BY merchant_id
"""
    )

STATEMENTS.append("COMMIT")
