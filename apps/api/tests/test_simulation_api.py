from __future__ import annotations

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


def register_gold() -> None:
    gold = cast(dict[str, Any], json.loads(FIXTURE.read_text(encoding="utf-8")))
    settings = get_settings()
    store = DatasetStore(
        analytics_path=settings.analytics_database,
        control_path=settings.control_database,
    )
    for dataset_id, data_type, key in (
        (ORDERS_ID, DataType.ORDERS, "orders"),
        (WAREHOUSE_ID, DataType.WAREHOUSE_EVENTS, "warehouse_events"),
        (TRACKING_ID, DataType.TRACKING_EVENTS, "tracking_events"),
    ):
        store.register(
            dataset_id=dataset_id,
            data_type=data_type,
            task_id=f"simulation-{key}",
            rows=gold[key],
        )


def selection() -> dict[str, str]:
    return {
        "orders_dataset_id": ORDERS_ID,
        "warehouse_events_dataset_id": WAREHOUSE_ID,
        "tracking_events_dataset_id": TRACKING_ID,
    }


def test_parameter_catalog_and_baseline(client: TestClient) -> None:
    register_gold()
    catalog = client.get("/api/simulations/parameters")
    baseline = client.post(
        "/api/simulations/baseline",
        json={"datasets": selection(), "timezone": "Asia/Shanghai"},
    )

    assert catalog.status_code == 200
    assert len(catalog.json()["parameters"]) == 5
    assert baseline.status_code == 200
    payload = baseline.json()
    assert payload["order_count"] == 8
    assert next(item for item in payload["metrics"] if item["code"] == "otif_rate")["value"] == 0.6
    assert len(payload["input_fingerprint"]) == 64


def test_scenario_crud_supports_three_scenarios_copy_rename_delete(
    client: TestClient,
) -> None:
    register_gold()
    created: list[dict[str, Any]] = []
    for index in range(3):
        response = client.post(
            "/api/simulations/scenarios",
            json={
                "name": f"方案 {index + 1}",
                "datasets": selection(),
                "parameters": {},
            },
        )
        assert response.status_code == 201
        created.append(response.json())

    listed = client.get(
        "/api/simulations/scenarios",
        params={"orders_dataset_id": ORDERS_ID},
    )
    assert listed.status_code == 200
    assert len(listed.json()) == 3

    renamed = client.patch(
        f"/api/simulations/scenarios/{created[0]['scenario_id']}",
        json={"name": "改名方案"},
    )
    copied = client.post(
        f"/api/simulations/scenarios/{created[0]['scenario_id']}/copy",
        json={"name": "复制方案"},
    )
    deleted = client.delete(f"/api/simulations/scenarios/{created[1]['scenario_id']}")

    assert renamed.status_code == 200
    assert renamed.json()["name"] == "改名方案"
    assert copied.status_code == 201
    assert copied.json()["scenario_id"] != created[0]["scenario_id"]
    assert deleted.status_code == 204


def test_run_stored_scenario_recalculates_metrics(client: TestClient) -> None:
    register_gold()
    created = client.post(
        "/api/simulations/scenarios",
        json={
            "name": "承诺策略",
            "datasets": selection(),
            "parameters": {"promise_strategy": {"extension_hours": 16}},
        },
    ).json()

    response = client.post(
        "/api/simulations/run",
        json={"datasets": selection(), "scenario_id": created["scenario_id"]},
    )

    assert response.status_code == 200
    payload = response.json()
    ot = next(item for item in payload["comparisons"] if item["code"] == "ot_rate")
    assert ot["baseline_value"] == 0.8
    assert ot["scenario_value"] == 1
    assert payload["affected_order_count"] == 7
    assert "情景估算" in payload["estimate_label"]


def test_inline_run_and_sensitivity_contract(client: TestClient) -> None:
    register_gold()
    run_response = client.post(
        "/api/simulations/run",
        json={
            "datasets": selection(),
            "scenario_name": "揽收改善",
            "parameters": {"pickup_improvement": {"reduction_hours": 1}},
        },
    )
    sensitivity = client.post(
        "/api/simulations/sensitivity",
        json={
            "datasets": selection(),
            "parameters": {"pickup_improvement": {"reduction_hours": 1}},
            "parameter": "pickup_reduction_hours",
            "values": [0, 0.5, 1],
        },
    )

    assert run_response.status_code == 200
    assert run_response.json()["affected_order_count"] == 1
    assert sensitivity.status_code == 200
    assert [item["parameter_value"] for item in sensitivity.json()["points"]] == [
        0,
        0.5,
        1,
    ]


def test_invalid_weights_and_dataset_mismatch_use_standard_errors(
    client: TestClient,
) -> None:
    register_gold()
    invalid = client.post(
        "/api/simulations/run",
        json={
            "datasets": selection(),
            "parameters": {"carrier_mix": {"weights": {"CAR-A": 90, "CAR-B": 5}}},
        },
    )
    created = client.post(
        "/api/simulations/scenarios",
        json={"name": "数据绑定", "datasets": selection(), "parameters": {}},
    ).json()
    mismatch_selection = {**selection(), "warehouse_events_dataset_id": None}
    mismatch = client.post(
        "/api/simulations/run",
        json={
            "datasets": mismatch_selection,
            "scenario_id": created["scenario_id"],
        },
    )

    assert invalid.status_code == 422
    assert invalid.json()["error"]["code"] == "VALIDATION_ERROR"
    assert mismatch.status_code == 422
    assert mismatch.json()["error"]["code"] == "SCENARIO_DATASET_MISMATCH"


def test_openapi_exposes_simulation_routes_and_versions(client: TestClient) -> None:
    schema = client.get("/openapi.json").json()
    version = client.get("/api/version").json()

    for route in (
        "/api/simulations/parameters",
        "/api/simulations/baseline",
        "/api/simulations/scenarios",
        "/api/simulations/scenarios/{scenario_id}",
        "/api/simulations/scenarios/{scenario_id}/copy",
        "/api/simulations/run",
        "/api/simulations/sensitivity",
    ):
        assert route in schema["paths"]
    assert version["contract_versions"]["simulation"] == "simulation-v1.0.0"
