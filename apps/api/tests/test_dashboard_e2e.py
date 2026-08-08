import json

from app.schemas.imports import DataType
from fastapi.testclient import TestClient

from scripts.demo_dashboard import FIXTURE, import_fixture


def test_synthetic_import_to_carrier_filter_and_anomaly_detail(
    client: TestClient,
) -> None:
    gold = json.loads(FIXTURE.read_text(encoding="utf-8"))
    datasets: dict[str, str] = {}
    for data_type, fixture_key in (
        (DataType.ORDERS, "orders"),
        (DataType.WAREHOUSE_EVENTS, "warehouse_events"),
        (DataType.TRACKING_EVENTS, "tracking_events"),
    ):
        dataset_id, result = import_fixture(
            client,
            data_type=data_type,
            rows=gold[fixture_key],
        )
        assert result["status"] == "analyzable"
        assert result["errors"] == 0
        datasets[data_type.value] = dataset_id

    selection = {
        "orders_dataset_id": datasets["orders"],
        "warehouse_events_dataset_id": datasets["warehouse_events"],
        "tracking_events_dataset_id": datasets["tracking_events"],
    }
    overview = client.get("/api/dashboard/overview", params=selection)
    assert overview.status_code == 200
    assert overview.json()["context"]["order_count"] == 8

    filtered = client.get(
        "/api/dashboard/overview",
        params={**selection, "carrier": "CAR-B"},
    )
    assert filtered.status_code == 200
    assert filtered.json()["active_filters"]["carriers"] == ["CAR-B"]
    assert filtered.json()["context"]["order_count"] == 2

    anomalies = client.get(
        "/api/dashboard/orders",
        params={
            **selection,
            "carrier": "CAR-B",
            "anomaly_type": "tracking_exception",
        },
    )
    assert anomalies.status_code == 200
    item = anomalies.json()["items"][0]
    assert item["order_id"] == "ORD-GOLD-002"
    assert item["anomaly_types"] == ["tracking_exception"]

    detail = client.get(
        f"/api/metrics/orders/{item['order_id']}",
        params=selection,
    )
    assert detail.status_code == 200
    assert any("exception" in reason for reason in detail.json()["anomaly_reasons"])
