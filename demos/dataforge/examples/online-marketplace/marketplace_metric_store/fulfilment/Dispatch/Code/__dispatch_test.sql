-- Dispatch metric regression checks for the confirmed 2026-07-27 to 2026-11-23 window.

CREATE OR REPLACE TEMP VIEW dispatch_test_events AS
WITH first_dispatch AS (
    SELECT
        order_id,
        MIN(attempted_at) AS dispatched_at
    FROM demo_gold_commerce.dispatch_attempts
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
    FROM demo_gold_commerce.orders o
    LEFT JOIN first_dispatch d
        ON d.order_id = o.order_id
    WHERE o.is_deleted = false
)
SELECT
    CAST(dispatched_at AS DATE) AS event_date,
    merchant_id,
    'total_dispatch_meet_count' AS metric_name,
    COUNT(DISTINCT order_id) AS metric_value
FROM promises
WHERE dispatched_at IS NOT NULL
  AND dispatched_at <= deadline_at
GROUP BY ALL
UNION ALL
SELECT
    CAST(deadline_at AS DATE) AS event_date,
    merchant_id,
    'total_dispatch_miss_count' AS metric_name,
    COUNT(DISTINCT order_id) AS metric_value
FROM promises
WHERE (dispatched_at IS NULL OR dispatched_at > deadline_at)
  AND (cancelled_at IS NULL OR cancelled_at >= deadline_at)
GROUP BY ALL;

CREATE OR REPLACE TEMP VIEW dispatch_test_calendar AS
SELECT
    CAST(snapshot_day AS DATE) AS snapshot_date
FROM generate_series(
    DATE '2026-07-27',
    DATE '2026-11-23',
    INTERVAL 1 DAY
) AS days(snapshot_day);

CREATE OR REPLACE TEMP VIEW dispatch_test_expected_daily AS
SELECT
    event_date AS snapshot_date,
    merchant_id,
    metric_name,
    metric_value
FROM dispatch_test_events
WHERE event_date BETWEEN DATE '2026-07-27' AND DATE '2026-11-23';

CREATE OR REPLACE TEMP VIEW dispatch_test_expected_cumulative AS
SELECT
    calendar.snapshot_date,
    events.merchant_id,
    events.metric_name,
    SUM(events.metric_value) AS metric_value
FROM dispatch_test_calendar calendar
JOIN dispatch_test_events events
    ON events.event_date <= calendar.snapshot_date
GROUP BY ALL;

SELECT
    'daily metric rollup' AS test_name,
    COUNT(*) AS failures
FROM (
    SELECT
        expected.snapshot_date,
        expected.merchant_id,
        expected.metric_name,
        expected.metric_value AS expected_value,
        actual.metric_value AS actual_value
    FROM (
        SELECT snapshot_date, merchant_id, metric_name, metric_value
        FROM dispatch_test_expected_daily
    ) expected
    FULL OUTER JOIN demo_gold_marketplace_metric_store.Dispatch_Merchant_Metrics_Snapshot_Daily actual
        ON actual.SNAPSHOT_DATE = expected.snapshot_date
        AND actual.merchant_id = expected.merchant_id
        AND actual.metric_name = expected.metric_name
    WHERE COALESCE(expected.metric_value, 0) <> COALESCE(actual.metric_value, 0)
);

SELECT
    'cumulative metric rollup' AS test_name,
    COUNT(*) AS failures
FROM (
    SELECT
        expected.snapshot_date,
        expected.merchant_id,
        expected.metric_name,
        expected.metric_value AS expected_value,
        actual.metric_value AS actual_value
    FROM dispatch_test_expected_cumulative expected
    FULL OUTER JOIN demo_gold_marketplace_metric_store.Dispatch_Merchant_Metrics_Snapshot_Cumulative actual
        ON actual.SNAPSHOT_DATE = expected.snapshot_date
        AND actual.merchant_id = expected.merchant_id
        AND actual.metric_name = expected.metric_name
    WHERE COALESCE(expected.metric_value, 0) <> COALESCE(actual.metric_value, 0)
);

SELECT
    'daily source versus target row count' AS test_name,
    COUNT(*) AS failures
FROM (
    SELECT
        expected.snapshot_date,
        expected.row_count AS expected_count,
        actual.row_count AS actual_count
    FROM (
        SELECT snapshot_date, COUNT(*) AS row_count
        FROM dispatch_test_expected_daily
        GROUP BY snapshot_date
    ) expected
    FULL OUTER JOIN (
        SELECT SNAPSHOT_DATE AS snapshot_date, COUNT(*) AS row_count
        FROM demo_gold_marketplace_metric_store.Dispatch_Merchant_Metrics_Snapshot_Daily
        GROUP BY SNAPSHOT_DATE
    ) actual
        ON actual.snapshot_date = expected.snapshot_date
    WHERE COALESCE(expected.row_count, 0) <> COALESCE(actual.row_count, 0)
);

SELECT
    'cumulative source versus target row count' AS test_name,
    COUNT(*) AS failures
FROM (
    SELECT
        expected.snapshot_date,
        expected.row_count AS expected_count,
        actual.row_count AS actual_count
    FROM (
        SELECT snapshot_date, COUNT(*) AS row_count
        FROM dispatch_test_expected_cumulative
        GROUP BY snapshot_date
    ) expected
    FULL OUTER JOIN (
        SELECT SNAPSHOT_DATE AS snapshot_date, COUNT(*) AS row_count
        FROM demo_gold_marketplace_metric_store.Dispatch_Merchant_Metrics_Snapshot_Cumulative
        GROUP BY SNAPSHOT_DATE
    ) actual
        ON actual.snapshot_date = expected.snapshot_date
    WHERE COALESCE(expected.row_count, 0) <> COALESCE(actual.row_count, 0)
);

SELECT
    'active merchant grain completeness' AS test_name,
    CASE
        WHEN COUNT(DISTINCT merchant_id) FILTER (WHERE metric_value > 0) > 0 THEN 0
        ELSE 1
    END AS failures
FROM demo_gold_marketplace_metric_store.Dispatch_Merchant_Metrics_Snapshot_Daily;

SELECT
    'date range coverage' AS test_name,
    COUNT(*) AS failures
FROM (
    SELECT expected.snapshot_date
    FROM (SELECT DISTINCT snapshot_date FROM dispatch_test_expected_daily) expected
    LEFT JOIN (
        SELECT DISTINCT SNAPSHOT_DATE AS snapshot_date
        FROM demo_gold_marketplace_metric_store.Dispatch_Merchant_Metrics_Snapshot_Daily
    ) actual
        ON actual.snapshot_date = expected.snapshot_date
    WHERE actual.snapshot_date IS NULL
);

SELECT
    'NULL checks' AS test_name,
    COUNT(*) AS failures
FROM demo_gold_marketplace_metric_store.Dispatch_Merchant_Metrics_Snapshot_Daily
WHERE SNAPSHOT_DATE IS NULL
   OR merchant_id IS NULL
   OR metric_name IS NULL
   OR metric_value IS NULL
   OR LOAD_TIMESTAMP IS NULL
   OR SOURCE_ZONE IS NULL;

SELECT
    'cumulative NULL checks' AS test_name,
    COUNT(*) AS failures
FROM demo_gold_marketplace_metric_store.Dispatch_Merchant_Metrics_Snapshot_Cumulative
WHERE SNAPSHOT_DATE IS NULL
   OR merchant_id IS NULL
   OR metric_name IS NULL
   OR metric_value IS NULL
   OR LOAD_TIMESTAMP IS NULL
   OR SOURCE_ZONE IS NULL;

SELECT
    'schema alignment' AS test_name,
    CASE WHEN actual_columns = expected_columns THEN 0 ELSE 1 END AS failures
FROM (
    SELECT
        list(column_name || ':' || data_type ORDER BY ordinal_position) AS actual_columns
    FROM information_schema.columns
    WHERE table_schema = 'demo_gold_marketplace_metric_store'
      AND table_name = 'Dispatch_Merchant_Metrics_Snapshot_Daily'
) actual
CROSS JOIN (
    SELECT [
        'SNAPSHOT_DATE:DATE',
        'merchant_id:BIGINT',
        'metric_name:VARCHAR',
        'metric_value:BIGINT',
        'LOAD_TIMESTAMP:TIMESTAMP',
        'SOURCE_ZONE:VARCHAR'
    ] AS expected_columns
) expected;

SELECT
    'cumulative schema alignment' AS test_name,
    CASE WHEN actual_columns = expected_columns THEN 0 ELSE 1 END AS failures
FROM (
    SELECT
        list(column_name || ':' || data_type ORDER BY ordinal_position) AS actual_columns
    FROM information_schema.columns
    WHERE table_schema = 'demo_gold_marketplace_metric_store'
      AND table_name = 'Dispatch_Merchant_Metrics_Snapshot_Cumulative'
) actual
CROSS JOIN (
    SELECT [
        'SNAPSHOT_DATE:DATE',
        'merchant_id:BIGINT',
        'metric_name:VARCHAR',
        'metric_value:BIGINT',
        'LOAD_TIMESTAMP:TIMESTAMP',
        'SOURCE_ZONE:VARCHAR'
    ] AS expected_columns
) expected;
