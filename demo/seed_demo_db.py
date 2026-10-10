"""Create demo.db for trying Query Guard.

The file gets one table, customers, with 1,000 fake rows.
The random seed is fixed, so every run makes the same rows.

Usage: python3 demo/seed_demo_db.py [path]   (default: demo.db)
"""

import datetime
import random
import sqlite3
import sys
from pathlib import Path

FIRST_NAMES = (
    "James Mary Robert Patricia John Jennifer Michael Linda David Elizabeth "
    "William Barbara Richard Susan Joseph Jessica Thomas Sarah Priya Arjun "
    "Wei Mei Carlos Sofia Ahmed Fatima Kenji Yuki Olu Amara"
).split()
LAST_NAMES = (
    "Smith Johnson Williams Brown Jones Garcia Miller Davis Rodriguez Martinez "
    "Patel Kim Nguyen Chen Singh Okafor Tanaka Muller Rossi Silva"
).split()
CITIES = [
    ("Cincinnati", "OH"), ("Columbus", "OH"), ("Chicago", "IL"), ("Austin", "TX"),
    ("Seattle", "WA"), ("Denver", "CO"), ("Boston", "MA"), ("Atlanta", "GA"),
    ("Phoenix", "AZ"), ("Portland", "OR"),
]
TIERS = ["bronze", "silver", "gold", "platinum"]
TIER_WEIGHTS = [50, 30, 15, 5]
ROWS = 1000


def fake_customers(rng: random.Random):
    start = datetime.date(2020, 1, 1)
    for i in range(1, ROWS + 1):
        first, last = rng.choice(FIRST_NAMES), rng.choice(LAST_NAMES)
        city, state = rng.choice(CITIES)
        yield (
            i,
            first,
            last,
            f"{first.lower()}.{last.lower()}{i}@example.com",
            f"555-{rng.randint(100, 999)}-{rng.randint(1000, 9999)}",
            city,
            state,
            (start + datetime.timedelta(days=rng.randint(0, 2100))).isoformat(),
            rng.choices(TIERS, TIER_WEIGHTS)[0],
            round(rng.lognormvariate(5.5, 1), 2),
            int(rng.random() < 0.85),
        )


def main() -> None:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "demo.db")
    if path.exists():
        sys.exit(f"{path} already exists; delete it first if you want a fresh copy.")

    db = sqlite3.connect(path)
    db.execute(
        """CREATE TABLE customers (
            id INTEGER PRIMARY KEY,
            first_name TEXT NOT NULL,
            last_name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            phone TEXT,
            city TEXT,
            state TEXT,
            signup_date TEXT,
            loyalty_tier TEXT,
            lifetime_value REAL,
            is_active INTEGER
        )"""
    )
    db.executemany(
        "INSERT INTO customers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        fake_customers(random.Random(42)),
    )
    db.commit()
    count = db.execute("SELECT COUNT(*) FROM customers").fetchone()[0]
    db.close()
    print(f"Created {path} with {count} customers.")


if __name__ == "__main__":
    main()
