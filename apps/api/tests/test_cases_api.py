from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from app.cases.generator import CASE_CONFIGS
from app.cases.models import CaseId
from app.cases.service import CaseService
from app.core.errors import AppError
from app.datasets.store import DatasetStore
from fastapi.testclient import TestClient

CASE_ROOT = Path(__file__).resolve().parents[3] / "data" / "cases"


def _import_csv(client: TestClient, case_id: CaseId, data_type: str) -> str:
    content = (CASE_ROOT / case_id.value / f"{data_type}.csv").read_bytes()
    uploaded = client.post(
        "/api/imports/upload",
        data={"data_type": data_type},
        files={"file": (f"{data_type}.csv", content, "text/csv")},
    )
    assert uploaded.status_code == 201, uploaded.text
    task = uploaded.json()["task"]
    parsed = client.post(
        f"/api/imports/{task['task_id']}/parse",
        json={"encoding": task["encoding"]},
    )
    assert parsed.status_code == 200, parsed.text
    parsed_payload = parsed.json()
    mapping = {
        item["source_column"]: item["suggested_field"] for item in parsed_payload["suggestions"]
    }
    checked = client.put(
        f"/api/imports/{task['task_id']}/validation",
        json={"mapping": mapping, "default_timezone": "Asia/Shanghai"},
    )
    assert checked.status_code == 200, checked.text
    report = checked.json()["report"]
    assert report["error_rows"] == 0
    assert report["invalid_times"] == 0
    assert report["time_order_conflicts"] == 0
    confirmed = client.post(f"/api/imports/{task['task_id']}/confirm")
    assert confirmed.status_code == 200, confirmed.text
    return str(confirmed.json()["dataset_id"])


def _selection_from_import(client: TestClient, case_id: CaseId) -> dict[str, str]:
    return {
        "orders_dataset_id": _import_csv(client, case_id, "orders"),
        "warehouse_events_dataset_id": _import_csv(client, case_id, "warehouse_events"),
        "tracking_events_dataset_id": _import_csv(client, case_id, "tracking_events"),
    }


def test_case_catalog_download_and_one_click_load(client: TestClient) -> None:
    catalog = client.get("/api/cases")
    assert catalog.status_code == 200
    assert [item["case_id"] for item in catalog.json()["cases"]] == [
        case_id.value for case_id in CaseId
    ]
    assert all(
        item["privacy_statement"].startswith("本案例完全由程序生成")
        for item in catalog.json()["cases"]
    )

    metadata = client.get("/api/cases/normal_operations/files/metadata.json")
    assert metadata.status_code == 200
    assert metadata.json()["seed"] == 20260801
    assert client.get("/api/cases/normal_operations/files/not-allowed.txt").status_code == 404

    loaded = client.post("/api/cases/promotion_surge/load")
    assert loaded.status_code == 201, loaded.text
    payload = loaded.json()
    assert payload["replaced_current_context"] is True
    assert payload["prior_datasets_retained"] is True
    summary = client.get("/api/metrics/summary", params=payload["datasets"])
    assert summary.status_code == 200
    assert (
        next(item for item in summary.json()["metrics"] if item["code"] == "order_count")["value"]
        == 240
    )


def test_case_load_missing_metadata_does_not_leave_datasets(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    before = client.get("/api/datasets").json()["datasets"]

    def missing_metadata(_case_id: CaseId) -> None:
        raise AppError(
            code="CASE_ARTIFACT_MISSING",
            message="synthetic missing metadata",
            status_code=500,
        )

    monkeypatch.setattr(CaseService, "_metadata", staticmethod(missing_metadata))
    response = client.post("/api/cases/normal_operations/load")

    assert response.status_code == 500
    assert response.json()["error"]["code"] == "CASE_ARTIFACT_MISSING"
    assert client.get("/api/datasets").json()["datasets"] == before


def test_case_load_rolls_back_when_dataset_registration_fails(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    before = client.get("/api/datasets").json()["datasets"]
    original_register = DatasetStore.register
    calls = 0

    def fail_second_registration(self: DatasetStore, **kwargs: Any):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("synthetic registration failure")
        return original_register(self, **kwargs)

    monkeypatch.setattr(DatasetStore, "register", fail_second_registration)
    with pytest.raises(RuntimeError, match="synthetic registration failure"):
        client.post("/api/cases/normal_operations/load")

    assert client.get("/api/datasets").json()["datasets"] == before


@pytest.mark.parametrize("case_id", list(CaseId))
def test_each_static_case_runs_import_metrics_diagnostics_and_simulation_smoke(
    client: TestClient,
    case_id: CaseId,
) -> None:
    datasets = _selection_from_import(client, case_id)
    summary = client.get("/api/metrics/summary", params=datasets)
    assert summary.status_code == 200, summary.text
    metrics: dict[str, dict[str, Any]] = {item["code"]: item for item in summary.json()["metrics"]}
    assert metrics["order_count"]["value"] == CASE_CONFIGS[case_id].order_count
    for code, (minimum, maximum, _) in CASE_CONFIGS[case_id].expected_metric_ranges.items():
        assert minimum <= float(metrics[code]["value"]) <= maximum

    diagnostics = client.post(
        "/api/diagnostics/analyze",
        json={"datasets": datasets, "timezone": "Asia/Shanghai", "max_evidence_per_result": 3},
    )
    assert diagnostics.status_code == 200, diagnostics.text
    triggered = {item["rule_id"] for item in diagnostics.json()["results"]}
    required = {
        rule_id
        for rule_id, _, is_required in CASE_CONFIGS[case_id].expected_findings
        if is_required
    }
    assert required <= triggered

    parameters: dict[str, object]
    if case_id == CaseId.PROMOTION_SURGE:
        parameters = {
            "warehouse_improvements": [
                {"node_code": "picking", "method": "percentage", "value": 10}
            ]
        }
    else:
        parameters = {"pickup_improvement": {"reduction_hours": 1}}
    simulation = client.post(
        "/api/simulations/run",
        json={
            "datasets": datasets,
            "scenario_name": f"{case_id.value}-smoke",
            "parameters": parameters,
        },
    )
    assert simulation.status_code == 200, simulation.text
    assert simulation.json()["affected_order_count"] > 0
    assert "情景估算" in simulation.json()["estimate_label"]
