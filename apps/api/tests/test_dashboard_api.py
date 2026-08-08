import json
from pathlib import Path
from typing import Any, cast

from app.core.config import get_settings
from app.datasets.store import DatasetStore
from app.schemas.imports import DataType
from fastapi.testclient import TestClient

FIXTURE = Path(__file__).parent / "fixtures" / "gold_metrics.json"
ORDERS_ID = "41111111-1111-4111-8111-111111111111"
WAREHOUSE_ID = "42222222-2222-4222-8222-222222222222"
TRACKING_ID = "43333333-3333-4333-8333-333333333333"


def register_dashboard_gold() -> dict[str, Any]:
    gold = cast(
        dict[str, Any],
        json.loads(FIXTURE.read_text(encoding="utf-8")),
    )
    settings = get_settings()
    store = DatasetStore(
        analytics_path=settings.analytics_database,
        control_path=settings.control_database,
    )
    for dataset_id, data_type, fixture_key in (
        (ORDERS_ID, DataType.ORDERS, "orders"),
        (WAREHOUSE_ID, DataType.WAREHOUSE_EVENTS, "warehouse_events"),
        (TRACKING_ID, DataType.TRACKING_EVENTS, "tracking_events"),
    ):
        store.register(
            dataset_id=dataset_id,
            data_type=data_type,
            task_id=f"dashboard-{fixture_key}",
            rows=gold[fixture_key],
        )
    return gold


def selection_params() -> dict[str, str]:
    return {
        "orders_dataset_id": ORDERS_ID,
        "warehouse_events_dataset_id": WAREHOUSE_ID,
        "tracking_events_dataset_id": TRACKING_ID,
    }


def metric(payload: dict[str, Any], code: str) -> dict[str, Any]:
    return next(item for item in payload["metrics"] if item["code"] == code)


def test_dashboard_overview_uses_one_reconcilable_filter_context(
    client: TestClient,
) -> None:
    gold = register_dashboard_gold()

    response = client.get(
        "/api/dashboard/overview",
        params={
            **selection_params(),
            "grain": "date",
            "dimension": "carrier_id",
            "breakdown_sort_by": "anomaly_order_rate",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["context"]["order_count"] == gold["expected"]["order_count"]
    assert payload["context"]["valid_order_count"] == gold["expected"]["valid_order_count"]
    assert metric(payload, "otif_rate")["value"] == gold["expected"]["otif_rate"]
    assert sum(group["order_count"] for group in payload["trend"]["groups"]) == 8
    assert sum(group["order_count"] for group in payload["breakdown"]["groups"]) == 8
    assert sum(item["count"] for item in payload["distribution"]["bins"]) == 6
    picking = next(node for node in payload["nodes"] if node["interval_code"] == "picking")
    assert picking["mean_hours"] == gold["expected"]["picking_hours"]
    assert payload["filter_options"]["carriers"][0]["count"] >= 1


def test_dashboard_filters_apply_to_every_view_and_keep_options(
    client: TestClient,
) -> None:
    register_dashboard_gold()

    response = client.get(
        "/api/dashboard/overview",
        params=[
            *selection_params().items(),
            ("carrier", "CAR-B"),
            ("dimension", "warehouse_id"),
        ],
    )

    assert response.status_code == 200
    payload = response.json()
    filtered_count = payload["context"]["order_count"]
    assert filtered_count == 2
    assert payload["context"]["unfiltered_order_count"] == 8
    assert sum(group["order_count"] for group in payload["trend"]["groups"]) == filtered_count
    assert sum(group["order_count"] for group in payload["breakdown"]["groups"]) == filtered_count
    assert payload["active_filters"]["carriers"] == ["CAR-B"]
    assert {item["value"] for item in payload["filter_options"]["carriers"]} >= {
        "CAR-A",
        "CAR-B",
    }


def test_dashboard_rejects_contradictory_date_filter(client: TestClient) -> None:
    register_dashboard_gold()

    response = client.get(
        "/api/dashboard/overview",
        params={
            **selection_params(),
            "start_date": "2026-07-04",
            "end_date": "2026-07-01",
        },
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_DASHBOARD_FILTER"


def test_dashboard_empty_filter_result_keeps_metrics_not_computable(
    client: TestClient,
) -> None:
    register_dashboard_gold()

    response = client.get(
        "/api/dashboard/overview",
        params=[*selection_params().items(), ("carrier", "CAR-NOT-FOUND")],
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["context"]["order_count"] == 0
    assert metric(payload, "otif_rate")["value"] is None
    assert metric(payload, "otif_rate")["denominator"] == 0
    assert payload["distribution"]["sample_size"] == 0
    assert payload["trend"]["groups"] == []


def test_dashboard_orders_paginate_sort_and_filter_anomalies(
    client: TestClient,
) -> None:
    register_dashboard_gold()

    response = client.get(
        "/api/dashboard/orders",
        params=[
            *selection_params().items(),
            ("anomaly_type", "tracking_exception"),
            ("page", "1"),
            ("page_size", "1"),
            ("sort_by", "order_id"),
            ("sort_direction", "asc"),
        ],
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] == 1
    assert payload["page_count"] == 1
    assert payload["items"][0]["order_id"] == "ORD-GOLD-002"
    assert payload["items"][0]["anomaly"] is True
    assert payload["items"][0]["anomaly_types"] == ["tracking_exception"]


def test_dashboard_csv_is_bom_encoded_and_formula_safe(client: TestClient) -> None:
    gold = register_dashboard_gold()
    settings = get_settings()
    store = DatasetStore(
        analytics_path=settings.analytics_database,
        control_path=settings.control_database,
    )
    dangerous_order = {
        **gold["orders"][0],
        "order_id": "=SUM(1,1)",
        "carrier_id": "+DANGEROUS",
    }
    dangerous_id = "44444444-4444-4444-8444-444444444444"
    store.register(
        dataset_id=dangerous_id,
        data_type=DataType.ORDERS,
        task_id="dashboard-csv-safety",
        rows=[dangerous_order],
    )

    response = client.get(
        "/api/dashboard/orders.csv",
        params={"orders_dataset_id": dangerous_id},
    )

    assert response.status_code == 200
    assert response.content.startswith(b"\xef\xbb\xbf")
    assert b"'=SUM(1,1)" in response.content
    assert b"'+DANGEROUS" in response.content
    assert "text/csv" in response.headers["content-type"]


def test_dashboard_order_time_sort_uses_absolute_instant(
    client: TestClient,
) -> None:
    gold = register_dashboard_gold()
    settings = get_settings()
    store = DatasetStore(
        analytics_path=settings.analytics_database,
        control_path=settings.control_database,
    )
    chronological_id = "45555555-5555-4555-8555-555555555555"
    store.register(
        dataset_id=chronological_id,
        data_type=DataType.ORDERS,
        task_id="dashboard-time-sort",
        rows=[
            {
                **gold["orders"][0],
                "order_id": "ORD-EARLIER",
                "created_at": "2026-07-01T10:00:00+08:00",
            },
            {
                **gold["orders"][0],
                "order_id": "ORD-LATER",
                "created_at": "2026-07-01T03:00:00+00:00",
            },
        ],
    )

    response = client.get(
        "/api/dashboard/orders",
        params={
            "orders_dataset_id": chronological_id,
            "sort_by": "created_at",
            "sort_direction": "desc",
        },
    )

    assert response.status_code == 200
    assert [item["order_id"] for item in response.json()["items"]] == [
        "ORD-LATER",
        "ORD-EARLIER",
    ]


def test_openapi_exposes_dashboard_contracts(client: TestClient) -> None:
    schema = client.get("/openapi.json").json()

    for route in (
        "/api/dashboard/overview",
        "/api/dashboard/orders",
        "/api/dashboard/orders.csv",
    ):
        assert route in schema["paths"]
    assert "DashboardOverviewResponse" in schema["components"]["schemas"]
