-- Replace the placeholders with the active catalog, table, comparison, and date.
WITH first_success AS (
    SELECT order_id, MIN(attempted_at) AS dispatched_at
    FROM {SOURCE_CATALOG}.dispatch_attempts
    WHERE is_deleted = false AND outcome = 'dispatched'
    GROUP BY order_id
),
eligible AS (
    SELECT o.order_id, o.merchant_id, o.placed_at + INTERVAL '48 hours' AS deadline_at,
           s.dispatched_at
    FROM {SOURCE_CATALOG}.orders o
    LEFT JOIN first_success s ON s.order_id = o.order_id
    WHERE o.is_deleted = false
      AND (o.cancelled_at IS NULL OR o.cancelled_at >= o.placed_at + INTERVAL '48 hours')
),
events AS (
    SELECT order_id, merchant_id, 'total_dispatch_meet_count' AS metric_name,
           dispatched_at AS event_at
    FROM eligible
    WHERE dispatched_at <= deadline_at
    UNION ALL
    SELECT order_id, merchant_id, 'total_dispatch_miss_count' AS metric_name,
           deadline_at AS event_at
    FROM eligible
    WHERE dispatched_at IS NULL OR dispatched_at > deadline_at
),
expected AS (
    SELECT merchant_id, metric_name, COUNT(DISTINCT order_id) AS metric_value
    FROM events
    WHERE CAST(event_at AS DATE) {DATE_COMPARISON} DATE '{SNAPSHOT_DATE}'
    GROUP BY merchant_id, metric_name
),
actual AS (
    SELECT merchant_id, metric_name, SUM(metric_value) AS metric_value,
           COUNT(*) AS row_count
    FROM {TARGET_TABLE}
    WHERE SNAPSHOT_DATE = DATE '{SNAPSHOT_DATE}'
    GROUP BY merchant_id, metric_name
),
comparison AS (
    SELECT expected.metric_value AS expected_value, actual.metric_value AS actual_value,
           actual.row_count
    FROM expected
    FULL OUTER JOIN actual USING (merchant_id, metric_name)
)
SELECT COUNT(*) FILTER (
    WHERE expected_value IS NULL OR actual_value IS NULL
       OR expected_value != actual_value OR row_count != 1
) AS mismatched_groups
FROM comparison;
