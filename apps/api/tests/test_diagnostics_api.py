from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from app.core.config import get_settings
from app.datasets.store import DatasetStore
from app.schemas.imports import DataType
from fastapi.testclient import TestClient

ORDERS_ID = "71111111-1111-4111-8111-111111111111"
WAREHOUSE_ID = "72222222-2222-4222-8222-222222222222"


def register_diagnostic_fixture() -> dict[str, Any]:
    created = datetime.fromisoformat("2026-07-01T08:00:00+08:00")
    orders = [
        {
            "order_id": "DIAG-001",
            "created_at": created.isoformat(),
            "promised_delivery_time": (created + timedelta(hours=48)).isoformat(),
            "actual_delivery_time": (created + timedelta(hours=24)).isoformat(),
            "ordered_quantity": 1,
            "delivered_quantity": 1,
            "quantity_unit": "piece",
            "order_status": "delivered",
            "raw_order_status": "已签收",
            "warehouse_id": "WH-A",
            "carrier_id": "CAR-A",
            "destination_region": "华东",
            "sales_channel": "synthetic",
        }
    ]
    warehouse = [
        {
            "event_id": "DW-1",
            "order_id": "DIAG-001",
            "event_time": created.isoformat(),
            "event_code": "order_received",
            "raw_status": "接单",
            "warehouse_id": "WH-A",
        },
        {
            "event_id": "DW-2",
            "order_id": "DIAG-001",
            "event_time": (created + timedelta(hours=5)).isoformat(),
            "event_code": "picking_started",
            "raw_status": "开始拣货",
            "warehouse_id": "WH-A",
        },
    ]
    settings = get_settings()
    store = DatasetStore(
        analytics_path=settings.analytics_database,
        control_path=settings.control_database,
    )
    store.register(
        dataset_id=ORDERS_ID,
        data_type=DataType.ORDERS,
        task_id="diagnostic-orders",
        rows=orders,
    )
    store.register(
        dataset_id=WAREHOUSE_ID,
        data_type=DataType.WAREHOUSE_EVENTS,
        task_id="diagnostic-warehouse",
        rows=warehouse,
    )
    return {
        "datasets": {
            "orders_dataset_id": ORDERS_ID,
            "warehouse_events_dataset_id": WAREHOUSE_ID,
        },
        "timezone": "Asia/Shanghai",
        "rule_overrides": {
            "FL-WH-001": {"enabled": True},
        },
    }


def test_rules_and_analysis_contract(client: TestClient) -> None:
    request = register_diagnostic_fixture()

    rules = client.get("/api/diagnostics/rules")
    response = client.post("/api/diagnostics/analyze", json=request)

    assert rules.status_code == 200
    assert len(rules.json()["rules"]) == 8
    assert response.status_code == 200
    payload = response.json()
    assert payload["rule_set_version"] == "diagnostics-v1.0.0"
    warehouse = next(item for item in payload["results"] if item["rule_id"] == "FL-WH-001")
    assert warehouse["affected_order_count"] == 1
    assert warehouse["evidence"][0]["order_id"] == "DIAG-001"
    assert warehouse["factual_observation"]
    assert warehouse["rule_judgement"]
    assert warehouse["recommended_checks"]


def test_order_page_reconciles_and_detail_has_timeline(client: TestClient) -> None:
    request = register_diagnostic_fixture()

    analysis = client.post("/api/diagnostics/analyze", json=request).json()
    orders = client.post(
        "/api/diagnostics/orders/search",
        params={"rule_id": "FL-WH-001"},
        json=request,
    )
    detail = client.post(
        "/api/diagnostics/orders/DIAG-001",
        json=request,
    )

    assert orders.status_code == 200
    assert orders.json()["total"] == analysis["context"]["affected_order_count"] == 1
    assert detail.status_code == 200
    payload = detail.json()
    assert payload["metric_detail"]["order_id"] == "DIAG-001"
    assert [item["event_code"] for item in payload["timeline"]] == [
        "order_received",
        "picking_started",
    ]
    assert payload["findings"][0]["evidence"][0]["order_id"] == "DIAG-001"


def test_invalid_override_is_rejected_with_standard_error(client: TestClient) -> None:
    request = register_diagnostic_fixture()
    request["rule_overrides"] = {"FL-WH-001": {"parameters": {"order_to_pick_threshold_hours": -1}}}

    response = client.post("/api/diagnostics/analyze", json=request)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "DIAGNOSTIC_PARAMETER_OUT_OF_RANGE"


def test_openapi_exposes_diagnostic_contracts(client: TestClient) -> None:
    schema = client.get("/openapi.json").json()

    for route in (
        "/api/diagnostics/rules",
        "/api/diagnostics/analyze",
        "/api/diagnostics/orders/search",
        "/api/diagnostics/orders/{order_id}",
    ):
        assert route in schema["paths"]
    assert "DiagnosticAnalysisResponse" in schema["components"]["schemas"]
