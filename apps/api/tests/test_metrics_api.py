import json
from pathlib import Path
from typing import Any, cast

from app.core.config import get_settings
from app.datasets.store import DatasetStore
from app.schemas.imports import DataType
from fastapi.testclient import TestClient

FIXTURE = Path(__file__).parent / "fixtures" / "gold_metrics.json"
ORDERS_ID = "11111111-1111-4111-8111-111111111111"
WAREHOUSE_ID = "22222222-2222-4222-8222-222222222222"
TRACKING_ID = "33333333-3333-4333-8333-333333333333"


def register_gold() -> dict[str, Any]:
    gold = cast(
        dict[str, Any],
        json.loads(FIXTURE.read_text(encoding="utf-8")),
    )
    settings = get_settings()
    store = DatasetStore(
        analytics_path=settings.analytics_database,
        control_path=settings.control_database,
    )
    store.register(
        dataset_id=ORDERS_ID,
        data_type=DataType.ORDERS,
        task_id="task-orders-gold",
        rows=gold["orders"],
    )
    store.register(
        dataset_id=WAREHOUSE_ID,
        data_type=DataType.WAREHOUSE_EVENTS,
        task_id="task-warehouse-gold",
        rows=gold["warehouse_events"],
    )
    store.register(
        dataset_id=TRACKING_ID,
        data_type=DataType.TRACKING_EVENTS,
        task_id="task-tracking-gold",
        rows=gold["tracking_events"],
    )
    return gold


def params() -> dict[str, str]:
    return {
        "orders_dataset_id": ORDERS_ID,
        "warehouse_events_dataset_id": WAREHOUSE_ID,
        "tracking_events_dataset_id": TRACKING_ID,
    }


def test_summary_api_returns_stable_metric_metadata(client: TestClient) -> None:
    gold = register_gold()

    response = client.get("/api/metrics/summary", params=params())

    assert response.status_code == 200
    payload = response.json()
    metrics = {item["code"]: item for item in payload["metrics"]}
    assert metrics["otif_rate"]["value"] == gold["expected"]["otif_rate"]
    assert metrics["otif_rate"]["numerator"] == 3
    assert metrics["otif_rate"]["denominator"] == 5
    assert metrics["otif_rate"]["coverage"] == gold["expected"]["ot_coverage"]
    assert metrics["otif_rate"]["definition_version"] == "metrics-v1.1.0"
    assert isinstance(metrics["otif_rate"]["warnings"], list)
    assert payload["rule_set_version"] == "metric-baseline-rules-v1.0.0"


def test_trend_api_supports_date_and_week(client: TestClient) -> None:
    register_gold()

    daily = client.get(
        "/api/metrics/trend",
        params={**params(), "grain": "date", "timezone": "Asia/Shanghai"},
    )
    weekly = client.get(
        "/api/metrics/trend",
        params={**params(), "grain": "week", "timezone": "Asia/Shanghai"},
    )

    assert daily.status_code == 200
    assert weekly.status_code == 200
    assert sum(group["order_count"] for group in daily.json()["groups"]) == 8
    assert weekly.json()["groups"][0]["key"] == "2026-06-29"


def test_distribution_api_has_reconcilable_bins(client: TestClient) -> None:
    register_gold()

    response = client.get(
        "/api/metrics/distribution",
        params={
            **params(),
            "metric_code": "fulfillment_duration_hours",
            "bin_count": 4,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["sample_size"] == 6
    assert sum(item["count"] for item in payload["bins"]) == 6
    assert payload["p90"] == 63


def test_breakdown_api_keeps_unknown_dimension_and_reconciles(
    client: TestClient,
) -> None:
    register_gold()

    response = client.get(
        "/api/metrics/breakdown",
        params={**params(), "dimension": "warehouse_id"},
    )

    assert response.status_code == 200
    groups = response.json()["groups"]
    assert next(group for group in groups if group["key"] == "unknown")["order_count"] == 2
    assert sum(group["order_count"] for group in groups) == 8


def test_order_detail_api_explains_decisions_and_nodes(
    client: TestClient,
) -> None:
    register_gold()

    response = client.get(
        "/api/metrics/orders/ORD-GOLD-001",
        params=params(),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["ot"]["status"] == "true"
    assert payload["in_full"]["status"] == "true"
    assert payload["otif"]["status"] == "true"
    assert {item["interval_code"] for item in payload["node_durations"]} >= {
        "picking",
        "ready_to_pickup",
        "carrier_transit",
        "hub_dwell",
    }


def test_wrong_dataset_type_and_missing_order_use_standard_errors(
    client: TestClient,
) -> None:
    register_gold()

    mismatch = client.get(
        "/api/metrics/summary",
        params={"orders_dataset_id": TRACKING_ID},
    )
    missing = client.get(
        "/api/metrics/orders/ORD-NOT-FOUND",
        params=params(),
    )

    assert mismatch.status_code == 422
    assert mismatch.json()["error"]["code"] == "DATASET_TYPE_MISMATCH"
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "ORDER_NOT_FOUND"


def test_openapi_exposes_all_metric_routes_and_example(client: TestClient) -> None:
    schema = client.get("/openapi.json").json()

    for route in (
        "/api/metrics/summary",
        "/api/metrics/trend",
        "/api/metrics/distribution",
        "/api/metrics/breakdown",
        "/api/metrics/orders/{order_id}",
    ):
        assert route in schema["paths"]
    metric_schema = schema["components"]["schemas"]["MetricResult"]
    assert metric_schema["example"]["code"] == "otif_rate"
