-- Dispatch pipeline tests. Each query returns test_name and failures, and a
-- test passes when failures = 0.
-- Substitute SOURCE_CATALOG, TARGET_CATALOG and SNAPSHOT_DATE before running,
-- after loading the Daily and Cumulative pipelines for SNAPSHOT_DATE.
-- The expected values are recomputed independently from the source tables
-- with QUALIFY rather than the pipeline's MIN() join.

CREATE OR REPLACE TEMP VIEW dispatch_expected AS
WITH first_success AS (
    SELECT order_id, attempted_at
    FROM {SOURCE_CATALOG}.dispatch_attempts
    WHERE NOT is_deleted
      AND outcome = 'dispatched'
    QUALIFY ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY attempted_at, attempt_id) = 1
),
judged AS (
    SELECT
        o.merchant_id,
        o.order_id,
        CASE
            WHEN f.attempted_at <= o.placed_at + INTERVAL 2 DAY THEN 'total_dispatch_meet_count'
            ELSE 'total_dispatch_miss_count'
        END AS metric_name,
        CASE
            WHEN f.attempted_at <= o.placed_at + INTERVAL 2 DAY THEN CAST(f.attempted_at AS DATE)
            ELSE CAST(o.placed_at + INTERVAL 2 DAY AS DATE)
        END AS event_date
    FROM {SOURCE_CATALOG}.orders AS o
    LEFT JOIN first_success AS f
        ON f.order_id = o.order_id
    WHERE NOT o.is_deleted
      AND NOT COALESCE(o.cancelled_at < o.placed_at + INTERVAL 2 DAY, false)
)
SELECT * FROM judged;

-- 1. Daily metric rollup matches the source for SNAPSHOT_DATE
WITH expected AS (
    SELECT merchant_id, metric_name, COUNT(*) AS metric_value
    FROM dispatch_expected
    WHERE event_date = DATE '{SNAPSHOT_DATE}'
    GROUP BY ALL
),
actual AS (
    SELECT merchant_id, metric_name, metric_value
    FROM {TARGET_CATALOG}.Dispatch_Merchant_Metrics_Snapshot_Daily
    WHERE SNAPSHOT_DATE = DATE '{SNAPSHOT_DATE}'
)
SELECT 'daily_rollup' AS test_name, COUNT(*) AS failures
FROM expected AS e
FULL OUTER JOIN actual AS a
    ON a.merchant_id = e.merchant_id
   AND a.metric_name = e.metric_name
WHERE e.metric_value IS DISTINCT FROM a.metric_value;

-- 2. Cumulative metric rollup matches the source up to SNAPSHOT_DATE
WITH expected AS (
    SELECT merchant_id, metric_name, COUNT(*) AS metric_value
    FROM dispatch_expected
    WHERE event_date <= DATE '{SNAPSHOT_DATE}'
    GROUP BY ALL
),
actual AS (
    SELECT merchant_id, metric_name, metric_value
    FROM {TARGET_CATALOG}.Dispatch_Merchant_Metrics_Snapshot_Cumulative
    WHERE SNAPSHOT_DATE = DATE '{SNAPSHOT_DATE}'
)
SELECT 'cumulative_rollup' AS test_name, COUNT(*) AS failures
FROM expected AS e
FULL OUTER JOIN actual AS a
    ON a.merchant_id = e.merchant_id
   AND a.metric_name = e.metric_name
WHERE e.metric_value IS DISTINCT FROM a.metric_value;

-- 3. Grain completeness: both cumulative metrics have merchant rows
SELECT 'grain_completeness' AS test_name, 2 - COUNT(DISTINCT metric_name) AS failures
FROM {TARGET_CATALOG}.Dispatch_Merchant_Metrics_Snapshot_Cumulative
WHERE SNAPSHOT_DATE = DATE '{SNAPSHOT_DATE}';

-- 4. No duplicate rows per date, merchant and metric
SELECT 'no_duplicates' AS test_name, COUNT(*) AS failures
FROM (
    SELECT SNAPSHOT_DATE, merchant_id, metric_name
    FROM {TARGET_CATALOG}.Dispatch_Merchant_Metrics_Snapshot_Daily
    GROUP BY ALL
    HAVING COUNT(*) > 1
    UNION ALL
    SELECT SNAPSHOT_DATE, merchant_id, metric_name
    FROM {TARGET_CATALOG}.Dispatch_Merchant_Metrics_Snapshot_Cumulative
    GROUP BY ALL
    HAVING COUNT(*) > 1
);

-- 5. Only the two Dispatch metric names, with positive values
SELECT 'metric_names_and_values' AS test_name, COUNT(*) AS failures
FROM (
    SELECT metric_name, metric_value FROM {TARGET_CATALOG}.Dispatch_Merchant_Metrics_Snapshot_Daily
    UNION ALL
    SELECT metric_name, metric_value FROM {TARGET_CATALOG}.Dispatch_Merchant_Metrics_Snapshot_Cumulative
)
WHERE metric_name NOT IN ('total_dispatch_meet_count', 'total_dispatch_miss_count')
   OR metric_value <= 0;

-- 6. Schema alignment: both tables expose the six store columns in order
SELECT 'schema_alignment' AS test_name, COUNT(*) AS failures
FROM (
    SELECT table_name, STRING_AGG(column_name, ',' ORDER BY ordinal_position) AS cols
    FROM information_schema.columns
    WHERE table_schema = '{TARGET_CATALOG}'
      AND table_name IN ('Dispatch_Merchant_Metrics_Snapshot_Daily', 'Dispatch_Merchant_Metrics_Snapshot_Cumulative')
    GROUP BY ALL
)
WHERE cols <> 'SNAPSHOT_DATE,merchant_id,metric_name,metric_value,LOAD_TIMESTAMP,SOURCE_ZONE';
