-- Dispatch promise metrics at merchant grain, counting promises met or missed on SNAPSHOT_DATE.
-- A promise is met when an order's first successful dispatch is within 48 hours
-- of placed_at, and missed when no dispatch happened by that deadline.
-- Uppercase columns are system columns written by every pipeline in the store.

CREATE TABLE IF NOT EXISTS {TARGET_CATALOG}.Dispatch_Merchant_Metrics_Snapshot_Daily (
    SNAPSHOT_DATE   DATE         NOT NULL,
    merchant_id     BIGINT       NOT NULL,
    metric_name     VARCHAR(128) NOT NULL,
    metric_value    BIGINT       NOT NULL,
    LOAD_TIMESTAMP  TIMESTAMP    NOT NULL,
    SOURCE_ZONE     VARCHAR(16)  NOT NULL
);
