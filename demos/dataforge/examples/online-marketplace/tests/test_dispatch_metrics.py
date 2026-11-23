import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


PROJECT = Path(__file__).resolve().parents[1]
STORE = PROJECT / "marketplace_metric_store"
ENTITY = STORE / "fulfilment" / "Dispatch"


class DispatchMetricsTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.database = Path(self.temp_dir.name) / "test.duckdb"
        self.sql(
            """
CREATE SCHEMA demo_gold_commerce;
CREATE SCHEMA demo_gold_marketplace_metric_store;
CREATE TABLE demo_gold_commerce.orders (
    order_id BIGINT, merchant_id BIGINT, placed_at TIMESTAMP,
    cancelled_at TIMESTAMP, is_deleted BOOLEAN
);
CREATE TABLE demo_gold_commerce.dispatch_attempts (
    order_id BIGINT, attempted_at TIMESTAMP, outcome VARCHAR, is_deleted BOOLEAN
);
INSERT INTO demo_gold_commerce.orders VALUES
    (1, 100, '2026-01-01 10:00:00', NULL, false),
    (2, 100, '2026-01-01 10:00:00', NULL, false),
    (3, 100, '2026-01-01 10:00:00', NULL, false),
    (4, 100, '2026-01-01 10:00:00', '2026-01-02 09:00:00', false),
    (5, 100, '2026-01-01 10:00:00', '2026-01-04 09:00:00', false),
    (6, 100, '2026-01-01 10:00:00', NULL, true),
    (7, 100, '2026-01-01 10:00:00', NULL, false),
    (8, 100, '2026-01-01 10:00:00', NULL, false),
    (9, 100, '2026-01-01 10:00:00', '2026-01-03 10:00:00', false),
    (10, 100, '2026-01-04 10:00:00', NULL, false),
    (11, 200, '2026-01-01 10:00:00', NULL, false);
INSERT INTO demo_gold_commerce.dispatch_attempts VALUES
    (1, '2026-01-01 11:00:00', 'failed', false),
    (1, '2026-01-01 12:00:00', 'dispatched', true),
    (1, '2026-01-02 15:00:00', 'dispatched', false),
    (1, '2026-01-02 18:00:00', 'dispatched', false),
    (2, '2026-01-04 10:00:00', 'dispatched', false),
    (3, '2026-01-02 10:00:00', 'failed', false),
    (4, '2026-01-02 08:00:00', 'dispatched', false),
    (6, '2026-01-02 08:00:00', 'dispatched', false),
    (7, '2026-01-02 09:00:00', 'dispatched', true),
    (8, '2026-01-03 10:00:00', 'dispatched', false),
    (11, '2026-01-02 09:00:00', 'dispatched', false);
"""
        )
        for cadence in ("Daily", "Cumulative"):
            path = ENTITY / "Schema" / f"Dispatch_Merchant_Metrics_Snapshot_{cadence}.sql"
            self.sql(path.read_text().replace("{TARGET_CATALOG}", "demo_gold_marketplace_metric_store"))

    def sql(self, statement, *, check=True):
        return subprocess.run(
            ["duckdb", "-bail", "-json", str(self.database)],
            input=statement,
            text=True,
            capture_output=True,
            check=check,
        )

    def pipeline(self, cadence, snapshot_date, *, zone="east", check=True):
        runner = STORE / "common" / f"{cadence.lower()}_runner.py"
        pipeline = ENTITY / "Code" / f"Dispatch_Metrics_Snapshot_{cadence}.py"
        env = dict(os.environ, ENGINE="duckdb", SOURCE_ZONE=zone,
                   SNAPSHOT_DATE=snapshot_date, PYTHONDONTWRITEBYTECODE="1")
        compiled = subprocess.run(
            ["python3", str(runner), str(pipeline)],
            cwd=PROJECT,
            env=env,
            text=True,
            capture_output=True,
            check=check,
        )
        if compiled.returncode:
            return compiled
        return self.sql(compiled.stdout, check=check)

    def values(self, cadence, snapshot_date):
        table = f"demo_gold_marketplace_metric_store.Dispatch_Merchant_Metrics_Snapshot_{cadence}"
        result = self.sql(
            f"SELECT merchant_id, metric_name, metric_value FROM {table} "
            f"WHERE SNAPSHOT_DATE = DATE '{snapshot_date}' ORDER BY merchant_id, metric_name;"
        )
        return {
            (row["merchant_id"], row["metric_name"]): row["metric_value"]
            for row in json.loads(result.stdout)
        }

    def reconciliation(self, cadence, snapshot_date):
        template = (ENTITY / "Code" / "__dispatch_test.sql").read_text()
        query = template.format(
            SOURCE_CATALOG="demo_gold_commerce",
            TARGET_TABLE=f"demo_gold_marketplace_metric_store.Dispatch_Merchant_Metrics_Snapshot_{cadence}",
            DATE_COMPARISON="=" if cadence == "Daily" else "<=",
            SNAPSHOT_DATE=snapshot_date,
        )
        return json.loads(self.sql(query).stdout)[0]["mismatched_groups"]

    def test_daily_boundaries_retries_cancellations_and_rerun(self):
        self.pipeline("Daily", "2026-01-02")
        self.assertEqual(self.values("Daily", "2026-01-02"), {
            (100, "total_dispatch_meet_count"): 1,
            (200, "total_dispatch_meet_count"): 1,
        })
        self.pipeline("Daily", "2026-01-03")
        expected = {
            (100, "total_dispatch_meet_count"): 1,
            (100, "total_dispatch_miss_count"): 5,
        }
        self.assertEqual(self.values("Daily", "2026-01-03"), expected)
        self.pipeline("Daily", "2026-01-03")
        self.assertEqual(self.values("Daily", "2026-01-03"), expected)
        self.assertEqual(self.reconciliation("Daily", "2026-01-03"), 0)
        self.assertEqual(len(self.values("Daily", "2026-01-02")), 2)

    def test_cumulative_preserves_misses_after_late_dispatch(self):
        expected = {
            (100, "total_dispatch_meet_count"): 2,
            (100, "total_dispatch_miss_count"): 5,
            (200, "total_dispatch_meet_count"): 1,
        }
        for snapshot_date in ("2026-01-03", "2026-01-04"):
            self.pipeline("Cumulative", snapshot_date)
            self.assertEqual(self.values("Cumulative", snapshot_date), expected)
            self.assertEqual(self.reconciliation("Cumulative", snapshot_date), 0)

    def test_reconciliation_detects_wrong_values(self):
        self.pipeline("Daily", "2026-01-03")
        self.sql(
            "UPDATE demo_gold_marketplace_metric_store.Dispatch_Merchant_Metrics_Snapshot_Daily "
            "SET metric_value = metric_value + 1 WHERE metric_name = 'total_dispatch_miss_count';"
        )
        self.assertEqual(self.reconciliation("Daily", "2026-01-03"), 1)

    def test_failed_reload_rolls_back_previous_snapshot(self):
        self.pipeline("Daily", "2026-01-03")
        expected = self.values("Daily", "2026-01-03")
        self.sql("DROP TABLE demo_gold_commerce.dispatch_attempts;")
        result = self.pipeline("Daily", "2026-01-03", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.values("Daily", "2026-01-03"), expected)

    def test_runner_rejects_bad_date_and_escapes_zone(self):
        invalid = self.pipeline("Daily", "not-a-date", check=False)
        self.assertNotEqual(invalid.returncode, 0)
        self.pipeline("Daily", "2026-01-03", zone="east'quoted")
        result = self.sql(
            "SELECT DISTINCT SOURCE_ZONE FROM "
            "demo_gold_marketplace_metric_store.Dispatch_Merchant_Metrics_Snapshot_Daily;"
        )
        self.assertEqual(json.loads(result.stdout), [{"SOURCE_ZONE": "east'quoted"}])


if __name__ == "__main__":
    unittest.main()
