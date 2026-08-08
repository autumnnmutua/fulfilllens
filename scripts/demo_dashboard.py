from __future__ import annotations

import csv
import io
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
from app.main import create_app  # noqa: E402
from app.schemas.imports import DataType  # noqa: E402

FIXTURE = ROOT / "apps" / "api" / "tests" / "fixtures" / "gold_metrics.json"
FIXTURE_KEYS = {
    DataType.ORDERS: "orders",
    DataType.WAREHOUSE_EVENTS: "warehouse_events",
    DataType.TRACKING_EVENTS: "tracking_events",
}


def csv_bytes(rows: list[dict[str, Any]]) -> bytes:
    headers = list(rows[0])
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=headers, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue().encode("utf-8")


def mapping_from(parse_payload: dict[str, Any]) -> dict[str, str | None]:
    return {
        str(item["source_column"]): (
            str(item["suggested_field"]) if item["suggested_field"] is not None else None
        )
        for item in parse_payload["suggestions"]
    }


def import_fixture(
    client: TestClient,
    *,
    data_type: DataType,
    rows: list[dict[str, Any]],
) -> tuple[str, dict[str, Any]]:
    uploaded = client.post(
        "/api/imports/upload",
        data={"data_type": data_type.value},
        files={
            "file": (
                f"{data_type.value}-phase5-synthetic.csv",
                csv_bytes(rows),
                "text/csv",
            )
        },
    )
    uploaded.raise_for_status()
    task_id = uploaded.json()["task"]["task_id"]
    parsed = client.post(f"/api/imports/{task_id}/parse", json={})
    parsed.raise_for_status()
    parsed_payload = parsed.json()
    validated = client.put(
        f"/api/imports/{task_id}/validation",
        json={
            "mapping": mapping_from(parsed_payload),
            "default_timezone": "Asia/Shanghai",
        },
    )
    validated.raise_for_status()
    validation_payload = validated.json()
    assert validation_payload["report"]["can_confirm"] is True
    confirmed = client.post(f"/api/imports/{task_id}/confirm")
    confirmed.raise_for_status()
    return str(confirmed.json()["dataset_id"]), {
        "data_type": data_type.value,
        "rows": parsed_payload["total_rows"],
        "valid_rows": validation_payload["report"]["valid_rows"],
        "errors": validation_payload["report"]["error_rows"],
        "status": confirmed.json()["task"]["status"],
    }


def main() -> None:
    gold = json.loads(FIXTURE.read_text(encoding="utf-8"))
    with TemporaryDirectory(prefix="fulfilllens-phase5-demo-") as temporary:
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
            with TestClient(create_app()) as client:
                datasets: dict[str, str] = {}
                import_results: list[dict[str, Any]] = []
                for data_type, fixture_key in FIXTURE_KEYS.items():
                    dataset_id, import_result = import_fixture(
                        client,
                        data_type=data_type,
                        rows=gold[fixture_key],
                    )
                    datasets[data_type.value] = dataset_id
                    import_results.append(import_result)

                selection = {
                    "orders_dataset_id": datasets["orders"],
                    "warehouse_events_dataset_id": datasets["warehouse_events"],
                    "tracking_events_dataset_id": datasets["tracking_events"],
                }
                overview = client.get(
                    "/api/dashboard/overview",
                    params={
                        **selection,
                        "grain": "date",
                        "dimension": "carrier_id",
                    },
                )
                overview.raise_for_status()
                overview_payload = overview.json()

                filtered = client.get(
                    "/api/dashboard/overview",
                    params={
                        **selection,
                        "carrier": "CAR-B",
                        "dimension": "carrier_id",
                    },
                )
                filtered.raise_for_status()
                filtered_payload = filtered.json()

                anomaly_orders = client.get(
                    "/api/dashboard/orders",
                    params={
                        **selection,
                        "carrier": "CAR-B",
                        "anomaly_type": "tracking_exception",
                        "sort_by": "anomaly",
                        "sort_direction": "desc",
                    },
                )
                anomaly_orders.raise_for_status()
                order_page = anomaly_orders.json()
                assert order_page["total"] >= 1
                selected_order = order_page["items"][0]

                detail = client.get(
                    f"/api/metrics/orders/{selected_order['order_id']}",
                    params=selection,
                )
                detail.raise_for_status()
                detail_payload = detail.json()

                checks = {
                    "all_imports_analyzable": all(
                        item["status"] == "analyzable" for item in import_results
                    ),
                    "overview_reconciles": overview_payload["context"]["order_count"] == 8,
                    "carrier_filter_applied": (
                        filtered_payload["active_filters"]["carriers"] == ["CAR-B"]
                        and filtered_payload["context"]["order_count"] == 2
                    ),
                    "anomaly_order_found": selected_order["anomaly"] is True,
                    "tracking_exception_explained": (
                        "tracking_exception" in selected_order["anomaly_types"]
                        and any(
                            "exception" in reason for reason in detail_payload["anomaly_reasons"]
                        )
                    ),
                }
                assert all(checks.values())
                print(
                    json.dumps(
                        {
                            "source": "完全合成金标准 CSV",
                            "path": [
                                "导入订单/仓库/物流样例",
                                "打开分析总览",
                                "筛选承运商 CAR-B",
                                "查看物流异常订单",
                            ],
                            "imports": import_results,
                            "overview": {
                                "orders": overview_payload["context"]["order_count"],
                                "coverage": overview_payload["context"]["data_coverage"],
                                "warnings": overview_payload["context"]["warning_count"],
                            },
                            "filtered_carrier": {
                                "carrier": "CAR-B",
                                "orders": filtered_payload["context"]["order_count"],
                            },
                            "selected_anomaly_order": {
                                "order_id": selected_order["order_id"],
                                "anomaly_types": selected_order["anomaly_types"],
                                "evidence": detail_payload["anomaly_reasons"],
                            },
                            "checks": checks,
                        },
                        ensure_ascii=False,
                        indent=2,
                    )
                )
        finally:
            get_settings.cache_clear()
            for key, previous_value in previous_environment.items():
                if previous_value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = previous_value


if __name__ == "__main__":
    main()
