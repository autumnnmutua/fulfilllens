from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from app.core.config import get_settings
from fastapi.testclient import TestClient

CASE_ROOT = Path(__file__).resolve().parents[3] / "data" / "cases"


def _import_file(
    client: TestClient,
    *,
    path: Path,
    data_type: str,
    sheet_name: str | None = None,
) -> tuple[str, str]:
    media_type = (
        "text/csv"
        if path.suffix == ".csv"
        else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    uploaded = client.post(
        "/api/imports/upload",
        data={"data_type": data_type},
        files={"file": (path.name, path.read_bytes(), media_type)},
    )
    assert uploaded.status_code == 201, uploaded.text
    task = uploaded.json()["task"]
    parse_payload: dict[str, str] = {}
    if task.get("encoding"):
        parse_payload["encoding"] = task["encoding"]
    if sheet_name:
        parse_payload["sheet_name"] = sheet_name
    parsed = client.post(f"/api/imports/{task['task_id']}/parse", json=parse_payload)
    assert parsed.status_code == 200, parsed.text
    mapping = {
        item["source_column"]: item["suggested_field"]
        for item in parsed.json()["suggestions"]
        if item["suggested_field"] is not None
    }
    validated = client.put(
        f"/api/imports/{task['task_id']}/validation",
        json={"mapping": mapping, "default_timezone": "Asia/Shanghai"},
    )
    assert validated.status_code == 200, validated.text
    assert validated.json()["report"]["error_rows"] == 0
    confirmed = client.post(f"/api/imports/{task['task_id']}/confirm")
    assert confirmed.status_code == 200, confirmed.text
    return str(confirmed.json()["dataset_id"]), str(task["task_id"])


def _wait_report(client: TestClient, job_id: str) -> dict[str, Any]:
    for _ in range(150):
        payload = client.get(f"/api/reports/jobs/{job_id}").json()
        if payload["status"] in {"completed", "failed", "cancelled"}:
            return payload
        time.sleep(0.02)
    raise AssertionError("报告任务未结束")


def test_e2e_csv_import_filter_diagnose_and_guided_report(client: TestClient) -> None:
    orders_id, _ = _import_file(
        client,
        path=CASE_ROOT / "carrier_disruption" / "orders.csv",
        data_type="orders",
    )
    selection = {"orders_dataset_id": orders_id}
    overview = client.get(
        "/api/dashboard/overview",
        params={**selection, "carrier": "CAR-SYN-SLOW"},
    )
    assert overview.status_code == 200, overview.text
    assert 0 < overview.json()["context"]["order_count"] < 180
    orders = client.get(
        "/api/dashboard/orders",
        params={**selection, "carrier": "CAR-SYN-SLOW", "page_size": 5},
    )
    assert orders.status_code == 200
    assert all(item["carrier_id"] == "CAR-SYN-SLOW" for item in orders.json()["items"])
    diagnosed = client.post(
        "/api/diagnostics/analyze",
        json={"datasets": selection, "timezone": "Asia/Shanghai"},
    )
    assert diagnosed.status_code == 200
    preview = client.post(
        "/api/reports/preview",
        json={
            "datasets": selection,
            "dataset_name": "CSV 全流程",
            "filters": {"carriers": ["CAR-SYN-SLOW"]},
            "sections": ["executive_summary", "metrics_overview", "diagnostics"],
            "reading_mode": "guided",
        },
    )
    assert preview.status_code == 200, preview.text
    assert preview.json()["header"]["order_count"] == overview.json()["context"]["order_count"]
    assert preview.json()["reading_guide"]


def test_e2e_xlsx_sheet_import_metrics_and_privacy_cleanup(client: TestClient) -> None:
    orders_id, task_id = _import_file(
        client,
        path=CASE_ROOT / "normal_operations" / "case.xlsx",
        data_type="orders",
        sheet_name="orders",
    )
    task_directory = get_settings().import_root / task_id
    assert task_directory.is_dir()
    summary = client.get("/api/metrics/summary", params={"orders_dataset_id": orders_id})
    assert summary.status_code == 200
    assert (
        next(item["value"] for item in summary.json()["metrics"] if item["code"] == "order_count")
        == 180
    )

    deleted = client.delete(f"/api/datasets/{orders_id}")
    assert deleted.status_code == 200
    assert deleted.json()["import_artifacts_deleted"] is True
    assert not task_directory.exists()
    assert (
        client.get("/api/metrics/summary", params={"orders_dataset_id": orders_id}).status_code
        == 404
    )


def test_e2e_case_simulation_export_and_complete_context_cleanup(
    client: TestClient,
) -> None:
    loaded = client.post("/api/cases/promotion_surge/load")
    assert loaded.status_code == 201
    datasets = loaded.json()["datasets"]
    simulation = client.post(
        "/api/simulations/run",
        json={
            "datasets": datasets,
            "scenario_name": "拣货改善验收",
            "parameters": {
                "warehouse_improvements": [
                    {"node_code": "picking", "method": "percentage", "value": 10}
                ]
            },
        },
    )
    assert simulation.status_code == 200, simulation.text
    assert simulation.json()["affected_order_count"] > 0

    job = client.post(
        "/api/reports/jobs",
        json={
            "report": {
                "datasets": datasets,
                "dataset_name": "促销案例验收",
                "sections": ["executive_summary", "metrics_overview", "simulation"],
                "simulation": {
                    "scenario_name": "拣货改善验收",
                    "parameters": {
                        "warehouse_improvements": [
                            {
                                "node_code": "picking",
                                "method": "percentage",
                                "value": 10,
                            }
                        ]
                    },
                },
                "reading_mode": "guided",
            },
            "format": "html",
        },
    )
    assert job.status_code == 202
    completed = _wait_report(client, job.json()["job_id"])
    assert completed["status"] == "completed", completed
    exported = client.get(f"/api/reports/jobs/{completed['job_id']}/download")
    assert exported.status_code == 200
    assert "快速阅读版：指标怎么读" in exported.text

    for dataset_id in datasets.values():
        assert client.delete(f"/api/datasets/{dataset_id}").status_code == 200
    assert client.get("/api/datasets").json()["total"] == 0
    assert client.get(f"/api/reports/jobs/{completed['job_id']}").status_code == 404
