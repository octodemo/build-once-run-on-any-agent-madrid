#!/usr/bin/env python3
"""Build the online-marketplace DuckDB warehouse from synthetic data.

Creates one .duckdb file per region under warehouse/:

    east.duckdb   Madrid Este fulfilment centre
    west.duckdb   Madrid Oeste fulfilment centre

Each file holds a source schema of raw marketplace data and a target schema
with the already-built Order metric tables. Every value is generated from a
fixed seed; no real data of any kind is involved.

    python seed.py                     # build warehouse/east.duckdb and west.duckdb
    python seed.py --check             # verify an existing warehouse instead
    python seed.py --warehouse DIR     # build somewhere else (the tests do this)

Requires the duckdb CLI on PATH (brew install duckdb).
"""

from __future__ import annotations

import argparse
import datetime as dt
import math
import pathlib
import random
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
STORE = HERE / "marketplace_metric_store"
DEFAULT_WAREHOUSE = HERE / "warehouse"

SOURCE_SCHEMA = "demo_gold_commerce"
TARGET_SCHEMA = "demo_gold_marketplace_metric_store"

# The window ends yesterday, which is what SNAPSHOT_DATE defaults to, so a
# pipeline run with no arguments lands on data whatever day the demo is given.
# All timestamps use Madrid local time.
DAYS = 120
END_DATE = dt.date.today() - dt.timedelta(days=1)
START_DATE = END_DATE - dt.timedelta(days=DAYS - 1)
# Nothing in the data happens after the end of yesterday.
DATA_END = dt.datetime.combine(END_DATE, dt.time(23, 59, 59))

# Order is already built end to end and is what forge-init learns the house
# style from. Dispatch is what the demo builds, so the seed never creates its
# tables -- only the pre-built entity's Schema/ files are applied.
PREBUILT_ENTITIES = ("Order",)
CADENCES = ("Daily", "Cumulative")
ORDER_METRICS = (
    ("total_order_place_count", "placed_at"),
    ("total_order_cancel_count", "cancelled_at"),
)

# merchant_id: (name, average orders per day, dispatch profile)
REGIONS = {
    "east": {
        "seed": 11,
        "first_order_id": 100001,
        "first_attempt_id": 500001,
        "merchants": {
            # Joined the marketplace last week: its only orders are the story
            # orders below, so every number for it can be explained by hand.
            1001: ("Harbour Homewares", 0.0, "story"),
            1002: ("Bondi Board Co.", 2.4, "fast"),
            1003: ("Paddington Paper Goods", 1.2, "normal"),
            1004: ("Manly Kitchen Supply", 2.0, "normal"),
            1005: ("Randwick Pet Pantry", 2.8, "fast"),
            1006: ("Newtown Vinyl Exchange", 0.9, "normal"),
            1007: ("Glebe Garden Tools", 1.6, "slow"),
            1008: ("Coogee Coffee Gear", 1.4, "fast"),
            1009: ("Surry Hills Stationery", 1.1, "normal"),
            1010: ("Balmain Bike Parts", 0.8, "normal"),
            1011: ("Chatswood Tech Accessories", 2.2, "normal"),
            1012: ("Mosman Camping Supplies", 1.0, "slow"),
        },
    },
    "west": {
        "seed": 29,
        "first_order_id": 200001,
        "first_attempt_id": 600001,
        "merchants": {
            2001: ("Penrith Fishing Tackle", 1.3, "normal"),
            2002: ("Parramatta Swimwear", 1.8, "fast"),
            2003: ("Blacktown Sneakers", 2.1, "normal"),
            2004: ("Castle Hill Pantry", 1.5, "slow"),
            2005: ("Campbelltown Outdoor Co.", 0.9, "normal"),
            2006: ("Liverpool Homewares", 1.2, "fast"),
        },
    },
}

# Hours from an order being placed to the warehouse's first dispatch attempt:
# (usual range, share of orders that wait much longer, that longer range).
FIRST_ATTEMPT_HOURS = {
    "fast": ((2, 20), 0.02, (40, 70)),
    "normal": ((4, 34), 0.05, (40, 80)),
    "slow": ((10, 46), 0.18, (45, 96)),
}
FAILURE_REASONS = (
    "carrier no-show",
    "label printer fault",
    "address check",
    "item not found on shelf",
)
TEST_ORDER_SHARE = 0.03


def story_day(day: int, hhmm: str) -> dt.datetime:
    """Day 7 is yesterday; day 1 is six days before it."""
    hour, minute = (int(part) for part in hhmm.split(":"))
    return dt.datetime.combine(
        END_DATE - dt.timedelta(days=7 - day), dt.time(hour, minute)
    )


# The story orders for Harbour Homewares (east). They are data only: what
# happened to each order. The business rules that decide which of them met or
# missed the dispatch promise are agreed in the GitHub issue, not here.
#   (order_id, placed, cancelled, [(attempt time, outcome, failure reason)], is_deleted)
STORY_ORDERS = (
    (101, (1, "09:00"), None, [((2, "14:00"), "dispatched", None)], False),
    (102, (1, "10:00"), None, [((2, "16:00"), "failed", "carrier no-show")], False),
    (103, (1, "11:00"), (1, "15:00"), [], False),
    (104, (7, "16:00"), None, [], False),
    (
        105,
        (1, "13:00"),
        None,
        [
            ((2, "10:00"), "failed", "label printer fault"),
            ((3, "09:00"), "failed", "carrier no-show"),
            ((4, "09:00"), "dispatched", None),
        ],
        False,
    ),
    (106, (2, "12:00"), (5, "11:00"), [], False),
    (107, (1, "08:00"), None, [], True),  # a test order, soft-deleted
)
STORY_MERCHANT_ID = 1001


def poisson(rng: random.Random, mean: float) -> int:
    if mean <= 0:
        return 0
    limit, count, product = math.exp(-mean), 0, rng.random()
    while product > limit:
        count += 1
        product *= rng.random()
    return count


def hours(value: float) -> dt.timedelta:
    return dt.timedelta(minutes=round(value * 60))


def first_attempt_delay(rng: random.Random, profile: str) -> dt.timedelta:
    usual, slow_share, slow = FIRST_ATTEMPT_HOURS[profile]
    low, high = slow if rng.random() < slow_share else usual
    return hours(rng.uniform(low, high))


def simulate_order(rng: random.Random, placed: dt.datetime, profile: str):
    """Return (cancelled_at, attempts) for one order, before truncation."""
    roll = rng.random()
    attempts = []
    if roll < 0.04:
        # Changed their mind early: cancelled before anything was sent.
        return placed + hours(rng.uniform(1, 40)), attempts
    if roll < 0.05:
        # Waited past the promise, then gave up.
        if rng.random() < 0.5:
            attempts.append(
                (placed + hours(rng.uniform(20, 46)), "failed", rng.choice(FAILURE_REASONS))
            )
        return placed + hours(rng.uniform(52, 100)), attempts

    when = placed + first_attempt_delay(rng, profile)
    failures = rng.choices((0, 1, 2), weights=(85, 11, 4))[0]
    for _ in range(failures):
        attempts.append((when, "failed", rng.choice(FAILURE_REASONS)))
        when += hours(rng.uniform(6, 26))
    attempts.append((when, "dispatched", None))
    return None, attempts


def build_rows(zone: str):
    cfg = REGIONS[zone]
    rng = random.Random(cfg["seed"])
    orders, attempts = [], []
    next_order = cfg["first_order_id"]
    next_attempt = cfg["first_attempt_id"]

    def add(order_id, merchant_id, placed, cancelled, order_attempts, is_deleted):
        nonlocal next_attempt
        # Nothing has happened after the end of yesterday: later attempts and
        # cancellations are still in the future.
        order_attempts = [a for a in order_attempts if a[0] <= DATA_END]
        if cancelled is not None and cancelled > DATA_END:
            cancelled = None
        dispatched = any(outcome == "dispatched" for _, outcome, _ in order_attempts)
        status = "cancelled" if cancelled else "dispatched" if dispatched else "open"
        updated = max([placed] + [a[0] for a in order_attempts] + ([cancelled] if cancelled else []))
        orders.append(
            (order_id, merchant_id, merchant_id * 1000 + rng.randint(1, 600), status,
             placed, cancelled, updated, is_deleted)
        )
        for when, outcome, reason in order_attempts:
            attempts.append((next_attempt, order_id, when, outcome, reason, is_deleted))
            next_attempt += 1

    for merchant_id, (_, per_day, profile) in cfg["merchants"].items():
        if profile == "story":
            continue
        for offset in range(DAYS):
            day = START_DATE + dt.timedelta(days=offset)
            for _ in range(poisson(rng, per_day)):
                placed = dt.datetime.combine(day, dt.time(rng.randrange(7, 23), rng.randrange(60)))
                cancelled, order_attempts = simulate_order(rng, placed, profile)
                add(next_order, merchant_id, placed, cancelled, order_attempts,
                    rng.random() < TEST_ORDER_SHARE)
                next_order += 1

    if STORY_MERCHANT_ID in cfg["merchants"]:
        for order_id, placed, cancelled, story_attempts, is_deleted in STORY_ORDERS:
            add(
                order_id,
                STORY_MERCHANT_ID,
                story_day(*placed),
                story_day(*cancelled) if cancelled else None,
                [(story_day(*when), outcome, reason) for when, outcome, reason in story_attempts],
                is_deleted,
            )

    return orders, attempts


def sql_value(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, dt.datetime):
        return f"TIMESTAMP '{value:%Y-%m-%d %H:%M:%S}'"
    return "'" + str(value).replace("'", "''") + "'"


def insert(table: str, rows) -> str:
    if not rows:
        return ""
    values = ",\n".join("(" + ", ".join(sql_value(v) for v in row) + ")" for row in rows)
    return f"INSERT INTO {table} VALUES\n{values};"


def source_ddl() -> str:
    return f"""
CREATE SCHEMA IF NOT EXISTS {SOURCE_SCHEMA};
CREATE SCHEMA IF NOT EXISTS {TARGET_SCHEMA};

CREATE OR REPLACE TABLE {SOURCE_SCHEMA}.merchants (
    merchant_id     BIGINT,
    merchant_name   VARCHAR
);

CREATE OR REPLACE TABLE {SOURCE_SCHEMA}.orders (
    order_id        BIGINT,
    merchant_id     BIGINT,
    customer_id     BIGINT,
    status          VARCHAR,
    placed_at       TIMESTAMP,
    cancelled_at    TIMESTAMP,
    updated_at      TIMESTAMP,
    is_deleted      BOOLEAN
);

CREATE OR REPLACE TABLE {SOURCE_SCHEMA}.dispatch_attempts (
    attempt_id      BIGINT,
    order_id        BIGINT,
    attempted_at    TIMESTAMP,
    outcome         VARCHAR,
    failure_reason  VARCHAR,
    is_deleted      BOOLEAN
);
"""


def target_ddl() -> str:
    """Create the pre-built entities' tables from the store's own Schema files."""
    statements = []
    for entity in PREBUILT_ENTITIES:
        for path in sorted(STORE.glob(f"*/{entity}/Schema/*_Metrics_Snapshot_*.sql")):
            statements.append(path.read_text().replace("{TARGET_CATALOG}", TARGET_SCHEMA))
    if not statements:
        sys.exit(f"no Schema files found for {PREBUILT_ENTITIES} under {STORE}")
    return "\n".join(statements)


def order_history(zone: str) -> str:
    """Load the Order metric tables for the whole window, as the Order pipelines
    would have produced them. Daily counts events on the snapshot date;
    Cumulative counts everything up to and including it."""
    statements = []
    for cadence in CADENCES:
        op = "=" if cadence == "Daily" else "<="
        for metric, column in ORDER_METRICS:
            statements.append(
                f"""
INSERT INTO {TARGET_SCHEMA}.Order_Merchant_Metrics_Snapshot_{cadence}
SELECT d.snapshot_date, o.merchant_id, '{metric}', COUNT(*), now(), '{zone}'
FROM (SELECT UNNEST(generate_series(
        DATE '{START_DATE}',
        DATE '{END_DATE}',
        INTERVAL 1 DAY))::DATE AS snapshot_date) d
JOIN {SOURCE_SCHEMA}.orders o
  ON o.{column} IS NOT NULL AND CAST(o.{column} AS DATE) {op} d.snapshot_date
WHERE o.is_deleted = false
GROUP BY 1, 2
ORDER BY 1, 2;"""
            )
    return "\n".join(statements)


def run_sql(db: pathlib.Path, sql: str, *args: str) -> str:
    result = subprocess.run(
        ["duckdb", *args, str(db)], input=sql, capture_output=True, text=True
    )
    if result.returncode != 0:
        sys.exit(f"duckdb failed on {db.name}:\n{result.stderr.strip()}")
    return result.stdout


def build(warehouse: pathlib.Path) -> None:
    if shutil.which("duckdb") is None:
        sys.exit("duckdb CLI not found on PATH. Install it with: brew install duckdb")

    warehouse.mkdir(parents=True, exist_ok=True)
    for zone, cfg in REGIONS.items():
        db = warehouse / f"{zone}.duckdb"
        db.unlink(missing_ok=True)
        pathlib.Path(f"{db}.wal").unlink(missing_ok=True)
        orders, attempts = build_rows(zone)
        merchants = [(mid, name) for mid, (name, _, _) in cfg["merchants"].items()]
        run_sql(
            db,
            "\n".join(
                [
                    source_ddl(),
                    insert(f"{SOURCE_SCHEMA}.merchants", merchants),
                    insert(f"{SOURCE_SCHEMA}.orders", orders),
                    insert(f"{SOURCE_SCHEMA}.dispatch_attempts", attempts),
                    target_ddl(),
                    order_history(zone),
                ]
            ),
        )
        print(f"built {db}")
        print(summary(db).rstrip())


def summary(db: pathlib.Path) -> str:
    return run_sql(
        db,
        f"SELECT 'merchants' AS table_name, COUNT(*) AS row_count FROM {SOURCE_SCHEMA}.merchants "
        f"UNION ALL SELECT 'orders', COUNT(*) FROM {SOURCE_SCHEMA}.orders "
        f"UNION ALL SELECT 'dispatch_attempts', COUNT(*) FROM {SOURCE_SCHEMA}.dispatch_attempts "
        f"UNION ALL SELECT 'order metric rows (daily)', COUNT(*) "
        f"FROM {TARGET_SCHEMA}.Order_Merchant_Metrics_Snapshot_Daily;",
        "-box",
    )


def check(warehouse: pathlib.Path) -> None:
    missing = [z for z in REGIONS if not (warehouse / f"{z}.duckdb").exists()]
    if missing:
        sys.exit(f"missing region files: {', '.join(missing)}. Run: python seed.py")
    for zone in REGIONS:
        db = warehouse / f"{zone}.duckdb"
        tables = run_sql(
            db,
            "SELECT table_schema, table_name FROM information_schema.tables "
            "ORDER BY 1, 2;",
            "-box",
        )
        print(f"{zone}:\n{tables.rstrip()}\n{summary(db).rstrip()}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="verify instead of rebuild")
    parser.add_argument("--warehouse", type=pathlib.Path, default=DEFAULT_WAREHOUSE,
                        help="directory for the region .duckdb files (default: ./warehouse)")
    options = parser.parse_args()
    check(options.warehouse) if options.check else build(options.warehouse)
