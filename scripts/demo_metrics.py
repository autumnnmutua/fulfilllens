from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from app.core.config import get_settings  # noqa: E402
from app.datasets.store import DatasetStore  # noqa: E402
from app.main import create_app  # noqa: E402
from app.schemas.imports import DataType  # noqa: E402

FIXTURE = ROOT / "apps" / "api" / "tests" / "fixtures" / "gold_metrics.json"
DATASET_IDS = {
    DataType.ORDERS: "11111111-1111-4111-8111-111111111111",
    DataType.WAREHOUSE_EVENTS: "22222222-2222-4222-8222-222222222222",
    DataType.TRACKING_EVENTS: "33333333-3333-4333-8333-333333333333",
}


def register_gold_datasets(gold: dict[str, Any]) -> None:
    settings = get_settings()
    store = DatasetStore(
        analytics_path=settings.analytics_database,
        control_path=settings.control_database,
    )
    for data_type, fixture_key in (
        (DataType.ORDERS, "orders"),
        (DataType.WAREHOUSE_EVENTS, "warehouse_events"),
        (DataType.TRACKING_EVENTS, "tracking_events"),
    ):
        store.register(
            dataset_id=DATASET_IDS[data_type],
            data_type=data_type,
            task_id=f"demo-{data_type.value}",
            rows=gold[fixture_key],
        )


def main() -> None:
    gold = json.loads(FIXTURE.read_text(encoding="utf-8"))
    with TemporaryDirectory(prefix="fulfilllens-phase4-demo-") as temporary:
        demo_root = Path(temporary)
        environment = {
            "FL_IMPORT_ROOT": str(demo_root / "imports"),
            "FL_ANALYTICS_DATABASE": str(demo_root / "analytics.duckdb"),
            "FL_CONTROL_DATABASE": str(demo_root / "control.sqlite3"),
            "FL_ENVIRONMENT": "test",
        }
        previous_environment = {key: os.environ.get(key) for key in environment}
        os.environ.update(environment)
        get_settings.cache_clear()
        try:
            register_gold_datasets(gold)
            params = {
                "orders_dataset_id": DATASET_IDS[DataType.ORDERS],
                "warehouse_events_dataset_id": DATASET_IDS[DataType.WAREHOUSE_EVENTS],
                "tracking_events_dataset_id": DATASET_IDS[DataType.TRACKING_EVENTS],
            }
            with TestClient(create_app()) as client:
                summary = client.get("/api/metrics/summary", params=params)
                summary.raise_for_status()
                payload = summary.json()
                metrics = {item["code"]: item for item in payload["metrics"]}

                breakdown = client.get(
                    "/api/metrics/breakdown",
                    params={**params, "dimension": "warehouse_id"},
                )
                breakdown.raise_for_status()

                detail = client.get(
                    "/api/metrics/orders/ORD-GOLD-007",
                    params=params,
                )
                detail.raise_for_status()

                expected = gold["expected"]
                checks = {
                    "order_count": metrics["order_count"]["value"] == expected["order_count"],
                    "ot_rate": metrics["ot_rate"]["value"] == expected["ot_rate"],
                    "otif_rate": metrics["otif_rate"]["value"] == expected["otif_rate"],
                    "duration_p90": metrics["fulfillment_duration_p90_hours"]["value"]
                    == expected["duration_p90"],
                    "breakdown_reconciles": sum(
                        group["order_count"] for group in breakdown.json()["groups"]
                    )
                    == expected["order_count"],
                    "missing_promise_is_not_computable": (
                        detail.json()["ot"]["status"] == "not_computable"
                    ),
                }
                assert all(checks.values())

                result = {
                    "input": {
                        "source": "仓库内置金标准合成夹具",
                        "orders": len(gold["orders"]),
                        "warehouse_events": len(gold["warehouse_events"]),
                        "tracking_events": len(gold["tracking_events"]),
                    },
                    "selected_metrics": {
                        code: {
                            "value": metrics[code]["value"],
                            "numerator": metrics[code]["numerator"],
                            "denominator": metrics[code]["denominator"],
                            "coverage": metrics[code]["coverage"],
                            "definition_version": metrics[code]["definition_version"],
                        }
                        for code in (
                            "order_count",
                            "ot_rate",
                            "if_rate",
                            "otif_rate",
                            "fulfillment_duration_p90_hours",
                        )
                    },
                    "warehouse_groups": [
                        {
                            "key": group["key"],
                            "order_count": group["order_count"],
                        }
                        for group in breakdown.json()["groups"]
                    ],
                    "order_007_ot": detail.json()["ot"],
                    "checks": checks,
                }
                print(json.dumps(result, ensure_ascii=False, indent=2))
        finally:
            get_settings.cache_clear()
            for key, previous_value in previous_environment.items():
                if previous_value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = previous_value


if __name__ == "__main__":
    main()
