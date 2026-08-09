from __future__ import annotations

import time
from pathlib import Path
from threading import Event
from typing import Any

import pytest
from app.core.config import get_settings
from app.core.errors import AppError
from app.datasets.store import DatasetStore
from app.reports.jobs import ReportJobManager
from app.reports.models import ReportExportRequest
from app.schemas.imports import DataType
from fastapi.testclient import TestClient

from .test_dashboard_api import (
    ORDERS_ID,
    TRACKING_ID,
    WAREHOUSE_ID,
    register_dashboard_gold,
)


def report_request(*, include_identifiers: bool = False) -> dict[str, Any]:
    return {
        "datasets": {
            "orders_dataset_id": ORDERS_ID,
            "warehouse_events_dataset_id": WAREHOUSE_ID,
            "tracking_events_dataset_id": TRACKING_ID,
        },
        "dataset_name": "金标准合成案例",
        "filters": {
            "start_date": None,
            "end_date": None,
            "warehouses": [],
            "carriers": ["CAR-B"],
            "regions": [],
            "statuses": [],
            "anomaly_types": [],
            "timezone": "Asia/Shanghai",
        },
        "trend_grain": "date",
        "breakdown_dimension": "carrier_id",
        "sections": [
            "executive_summary",
            "data_quality",
            "metrics_overview",
            "trend",
            "node_duration",
            "dimension_breakdown",
            "diagnostics",
            "recommendations",
            "order_samples",
            "simulation",
            "methods_limits",
        ],
        "order_sample_limit": 10,
        "include_order_identifiers": include_identifiers,
        "sensitive_export_confirmed": include_identifiers,
    }


def wait_for_job(client: TestClient, job_id: str) -> dict[str, Any]:
    for _ in range(200):
        response = client.get(f"/api/reports/jobs/{job_id}")
        assert response.status_code == 200, response.text
        payload = response.json()
        if payload["status"] in {"completed", "failed", "cancelled"}:
            return payload
        time.sleep(0.02)
    raise AssertionError("报告导出任务未在测试时限内结束")


def create_export(
    client: TestClient,
    request: dict[str, Any],
    format_name: str,
    csv_kind: str | None = None,
) -> tuple[dict[str, Any], bytes, str]:
    response = client.post(
        "/api/reports/jobs",
        json={"report": request, "format": format_name, "csv_kind": csv_kind},
    )
    assert response.status_code == 202, response.text
    job = wait_for_job(client, response.json()["job_id"])
    assert job["status"] == "completed", job
    download = client.get(f"/api/reports/jobs/{job['job_id']}/download")
    assert download.status_code == 200, download.text
    return job, download.content, download.headers["content-disposition"]


def test_preview_follows_filters_versions_sections_and_masks_identifiers(
    client: TestClient,
) -> None:
    register_dashboard_gold()
    response = client.post("/api/reports/preview", json=report_request())
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["header"]["order_count"] == 2
    assert payload["header"]["metrics_definition_version"] == "metrics-v1.1.0"
    assert payload["header"]["diagnostic_rule_version"] == "diagnostics-v1.0.0"
    assert payload["header"]["simulation_version"] == "simulation-v1.0.0"
    assert payload["filters"]["carriers"] == ["CAR-B"]
    assert [section["code"] for section in payload["sections"]] == report_request()["sections"]
    orders = next(section for section in payload["sections"] if section["code"] == "order_samples")[
        "data"
    ]["orders"]
    assert orders and all(item["order_id"].startswith("***") for item in orders)
    diagnostics = next(
        section for section in payload["sections"] if section["code"] == "diagnostics"
    )
    for result in diagnostics["data"]["results"]:
        assert all(
            evidence.get("order_id") in {None, ""} or evidence["order_id"].startswith("***")
            for evidence in result["evidence"]
        )
    recommendations = payload["recommendations"]
    assert recommendations["ai_used"] is False
    assert recommendations["presentation_source"] == "deterministic_template"
    fact_ids = {item["fact_id"] for item in recommendations["facts"]}
    assert fact_ids
    assert {item["fact_id"] for item in recommendations["professional_action_plan"]} == fact_ids
    assert {
        item["fact_id"] for item in recommendations["executive_brief"]["top_priorities"]
    } <= fact_ids


def test_sensitive_identifier_export_requires_confirmation(client: TestClient) -> None:
    register_dashboard_gold()
    request = report_request(include_identifiers=True)
    request["sensitive_export_confirmed"] = False
    denied = client.post("/api/reports/preview", json=request)
    assert denied.status_code == 422
    request["sensitive_export_confirmed"] = True
    allowed = client.post("/api/reports/preview", json=request)
    assert allowed.status_code == 200
    orders = next(
        section for section in allowed.json()["sections"] if section["code"] == "order_samples"
    )["data"]["orders"]
    assert orders and all(not item["order_id"].startswith("***") for item in orders)


def test_markdown_and_self_contained_html_are_complete_and_chinese_safe(
    client: TestClient,
) -> None:
    register_dashboard_gold()
    request = report_request()
    request["dataset_name"] = "金标准<script>alert(1)</script>"
    markdown_job, markdown, _ = create_export(client, request, "markdown")
    assert markdown_job["file_name"].endswith(".md")
    markdown_text = markdown.decode("utf-8-sig")
    assert "Executive Summary" in markdown_text
    assert "数据观察事实" in markdown_text
    assert "情景估算" in markdown_text
    assert "专业行动方案" in markdown_text
    assert "管理层简报" in markdown_text
    assert "<script>" not in markdown_text
    assert "&lt;script&gt;" in markdown_text

    html_job, document, disposition = create_export(client, request, "html")
    assert html_job["file_name"].endswith(".html")
    html_text = document.decode("utf-8")
    assert '<html lang="zh-CN">' in html_text
    assert "<svg" in html_text
    assert "可能原因（未经因果验证）" in html_text
    assert "http://" not in html_text and "https://" not in html_text
    assert "<script" not in html_text and "<link" not in html_text
    assert "filename*=UTF-8''" in disposition


def test_guided_report_explains_direction_and_interpretation_limits(
    client: TestClient,
) -> None:
    register_dashboard_gold()
    request = report_request()
    request["reading_mode"] = "guided"

    preview = client.post("/api/reports/preview", json=request)
    assert preview.status_code == 200, preview.text
    payload = preview.json()
    assert payload["reading_mode"] == "guided"
    assert len(payload["reading_guide"]) >= 8
    otif = next(item for item in payload["reading_guide"] if item["term"].startswith("OTIF"))
    assert "越高越好" in otif["direction"]
    assert otif["requires_context"] is True
    assert "覆盖率" in otif["caution"]

    _, markdown, _ = create_export(client, request, "markdown")
    _, html, _ = create_export(client, request, "html")
    assert "快速阅读版：指标怎么读" in markdown.decode("utf-8-sig")
    html_text = html.decode("utf-8")
    assert "快速阅读版：指标怎么读" in html_text
    assert "需结合上下文" in html_text
    assert "<caption>" in html_text


def test_all_five_csv_exports_are_utf8_bom_formula_safe_and_reconcilable(
    client: TestClient,
) -> None:
    register_dashboard_gold()
    request = report_request()
    request["simulation"] = {
        "scenario_name": "减少揽收等待",
        "parameters": {"pickup_improvement": {"reduction_hours": 1}},
    }
    for kind in (
        "anomaly_orders",
        "data_quality_errors",
        "status_mapping",
        "metric_detail",
        "simulation_comparison",
    ):
        job, content, _ = create_export(client, request, "csv", kind)
        assert job["csv_kind"] == kind
        assert content.startswith(b"\xef\xbb\xbf")
        text = content.decode("utf-8-sig")
        assert "\x00" not in text
        if kind == "metric_detail":
            assert "otif_rate" in text and "CAR-B" in text
        if kind == "simulation_comparison":
            assert "情景估算" in text and "simulation-v1.0.0" in text


def test_capabilities_truthfully_keep_pdf_unavailable(client: TestClient) -> None:
    response = client.get("/api/reports/capabilities")
    assert response.status_code == 200
    payload = response.json()
    assert payload["supported_formats"] == ["markdown", "html", "csv"]
    assert payload["pdf_available"] is False
    assert "Docker" in payload["pdf_reason"]


def test_empty_dataset_report_does_not_invent_zero_success(
    client: TestClient,
    tmp_path: Path,
) -> None:
    settings = get_settings()
    store = DatasetStore(
        analytics_path=settings.analytics_database,
        control_path=settings.control_database,
    )
    empty_id = "71111111-1111-4111-8111-111111111111"
    store.register(
        dataset_id=empty_id,
        data_type=DataType.ORDERS,
        task_id="empty-report-orders",
        rows=[],
    )
    request = report_request()
    request["datasets"] = {"orders_dataset_id": empty_id}
    request["filters"]["carriers"] = []
    request["sections"] = ["executive_summary", "metrics_overview", "methods_limits"]
    response = client.post("/api/reports/preview", json=request)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["header"]["order_count"] == 0
    assert any("不可计算" in item for item in payload["executive_summary"])


def test_export_job_can_be_cancelled_without_exposing_internal_error() -> None:
    started = Event()

    class BlockingService:
        def render_report(
            self,
            request: object,
            *,
            format_name: str,
            progress: Any,
            cancelled: Any,
        ) -> bytes:
            del request, format_name
            started.set()
            while not cancelled():
                progress(20, "测试等待")
                time.sleep(0.005)
            raise AppError(
                code="REPORT_EXPORT_CANCELLED",
                message="报告导出已取消。",
                status_code=409,
            )

    payload = ReportExportRequest.model_validate(
        {
            "report": {
                "datasets": {"orders_dataset_id": ORDERS_ID},
                "sections": ["executive_summary"],
            },
            "format": "html",
        }
    )
    manager = ReportJobManager(max_workers=1)
    try:
        job = manager.start(
            payload,
            service=BlockingService(),  # type: ignore[arg-type]
            max_export_bytes=1024,
        )
        assert started.wait(timeout=2)
        cancelled = manager.cancel(job.job_id)
        assert cancelled.status == "cancelled"
        time.sleep(0.03)
        assert manager.get(job.job_id).error_code == "REPORT_EXPORT_CANCELLED"
    finally:
        manager.shutdown()


def test_export_job_queue_rejects_unbounded_running_jobs() -> None:
    started = Event()

    class BlockingService:
        def render_report(
            self,
            request: object,
            *,
            format_name: str,
            progress: Any,
            cancelled: Any,
        ) -> bytes:
            del request, format_name, progress
            started.set()
            while not cancelled():
                time.sleep(0.005)
            raise AppError(
                code="REPORT_EXPORT_CANCELLED",
                message="报告导出已取消。",
                status_code=409,
            )

    payload = ReportExportRequest.model_validate(
        {
            "report": {
                "datasets": {"orders_dataset_id": ORDERS_ID},
                "sections": ["executive_summary"],
            },
            "format": "html",
        }
    )
    manager = ReportJobManager(max_workers=1, max_jobs=1)
    try:
        first = manager.start(
            payload,
            service=BlockingService(),  # type: ignore[arg-type]
            max_export_bytes=1024,
        )
        assert started.wait(timeout=2)
        with pytest.raises(AppError, match="任务已达上限") as error:
            manager.start(
                payload,
                service=BlockingService(),  # type: ignore[arg-type]
                max_export_bytes=1024,
            )
        assert error.value.code == "REPORT_EXPORT_QUEUE_FULL"
        manager.cancel(first.job_id)
    finally:
        manager.shutdown()
