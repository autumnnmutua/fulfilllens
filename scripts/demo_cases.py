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

from app.cases.generator import CASE_CONFIGS  # noqa: E402
from app.cases.models import CaseId  # noqa: E402
from app.core.config import get_settings  # noqa: E402
from app.main import create_app  # noqa: E402

CASE_ROOT = ROOT / "data" / "cases"


def import_table(client: TestClient, case_id: CaseId, data_type: str) -> tuple[str, dict[str, Any]]:
    content = (CASE_ROOT / case_id.value / f"{data_type}.csv").read_bytes()
    uploaded = client.post(
        "/api/imports/upload",
        data={"data_type": data_type},
        files={"file": (f"{data_type}.csv", content, "text/csv")},
    )
    uploaded.raise_for_status()
    task = uploaded.json()["task"]
    parsed = client.post(
        f"/api/imports/{task['task_id']}/parse",
        json={"encoding": task["encoding"]},
    )
    parsed.raise_for_status()
    parse_payload = parsed.json()
    mapping = {
        item["source_column"]: item["suggested_field"] for item in parse_payload["suggestions"]
    }
    checked = client.put(
        f"/api/imports/{task['task_id']}/validation",
        json={"mapping": mapping, "default_timezone": "Asia/Shanghai"},
    )
    checked.raise_for_status()
    report = checked.json()["report"]
    if report["error_rows"] or report["invalid_times"] or report["time_order_conflicts"]:
        raise RuntimeError(f"{case_id.value}/{data_type} 未通过导入质量门：{report}")
    confirmed = client.post(f"/api/imports/{task['task_id']}/confirm")
    confirmed.raise_for_status()
    return str(confirmed.json()["dataset_id"]), {
        "rows": report["valid_rows"],
        "errors": report["error_rows"],
        "unknown_statuses": report["unknown_statuses"],
        "time_conflicts": report["time_order_conflicts"],
    }


def metric_values(payload: dict[str, Any]) -> dict[str, float | int | None]:
    wanted = {
        "order_count",
        "ot_rate",
        "if_rate",
        "otif_rate",
        "fulfillment_duration_mean_hours",
        "fulfillment_duration_median_hours",
        "fulfillment_duration_p90_hours",
        "anomaly_order_rate",
    }
    return {item["code"]: item["value"] for item in payload["metrics"] if item["code"] in wanted}


def simulation_parameters(case_id: CaseId) -> dict[str, object]:
    if case_id == CaseId.PROMOTION_SURGE:
        return {
            "warehouse_improvements": [
                {"node_code": "picking", "method": "percentage", "value": 10}
            ]
        }
    if case_id == CaseId.CARRIER_DISRUPTION:
        return {"pickup_improvement": {"reduction_hours": 6}}
    return {"pickup_improvement": {"reduction_hours": 1}}


def main() -> None:
    with TemporaryDirectory(prefix="fulfilllens-cases-") as temporary:
        root = Path(temporary)
        environment = {
            "FL_IMPORT_ROOT": str(root / "imports"),
            "FL_ANALYTICS_DATABASE": str(root / "analytics.duckdb"),
            "FL_CONTROL_DATABASE": str(root / "control.sqlite3"),
            "FL_ENVIRONMENT": "test",
        }
        previous = {key: os.environ.get(key) for key in environment}
        os.environ.update(environment)
        get_settings.cache_clear()
        results: list[dict[str, object]] = []
        try:
            with TestClient(create_app()) as client:
                for case_id in CaseId:
                    orders_id, orders_quality = import_table(client, case_id, "orders")
                    warehouse_id, warehouse_quality = import_table(
                        client, case_id, "warehouse_events"
                    )
                    tracking_id, tracking_quality = import_table(client, case_id, "tracking_events")
                    datasets = {
                        "orders_dataset_id": orders_id,
                        "warehouse_events_dataset_id": warehouse_id,
                        "tracking_events_dataset_id": tracking_id,
                    }
                    summary = client.get("/api/metrics/summary", params=datasets)
                    summary.raise_for_status()
                    diagnostics = client.post(
                        "/api/diagnostics/analyze",
                        json={
                            "datasets": datasets,
                            "timezone": "Asia/Shanghai",
                            "max_evidence_per_result": 3,
                        },
                    )
                    diagnostics.raise_for_status()
                    diagnostic_payload = diagnostics.json()
                    triggered = sorted({item["rule_id"] for item in diagnostic_payload["results"]})
                    expected = sorted(
                        rule_id
                        for rule_id, _, required in CASE_CONFIGS[case_id].expected_findings
                        if required
                    )
                    if not set(expected) <= set(triggered):
                        raise RuntimeError(
                            f"{case_id.value} 未触发：{sorted(set(expected) - set(triggered))}"
                        )
                    simulation = client.post(
                        "/api/simulations/run",
                        json={
                            "datasets": datasets,
                            "scenario_name": f"{CASE_CONFIGS[case_id].display_name}教学练习",
                            "parameters": simulation_parameters(case_id),
                        },
                    )
                    simulation.raise_for_status()
                    simulation_payload = simulation.json()
                    comparison_codes = {
                        "otif_rate",
                        "fulfillment_duration_mean_hours",
                        "fulfillment_duration_p90_hours",
                    }
                    results.append(
                        {
                            "case_id": case_id.value,
                            "name": CASE_CONFIGS[case_id].display_name,
                            "seed": CASE_CONFIGS[case_id].seed,
                            "import_quality": {
                                "orders": orders_quality,
                                "warehouse_events": warehouse_quality,
                                "tracking_events": tracking_quality,
                            },
                            "metrics": metric_values(summary.json()),
                            "expected_rules": expected,
                            "triggered_rules": triggered,
                            "diagnostic_findings": diagnostic_payload["context"]["finding_count"],
                            "simulation": {
                                "parameters": simulation_parameters(case_id),
                                "affected_order_count": simulation_payload["affected_order_count"],
                                "comparisons": {
                                    item["code"]: {
                                        "baseline": item["baseline_value"],
                                        "scenario": item["scenario_value"],
                                        "absolute_change": item["absolute_change"],
                                    }
                                    for item in simulation_payload["comparisons"]
                                    if item["code"] in comparison_codes
                                },
                                "estimate_label": simulation_payload["estimate_label"],
                            },
                        }
                    )
            print(
                json.dumps(
                    {
                        "privacy": "全部输入为固定种子的完全合成数据。",
                        "workflow": "真实 CSV 上传 → 映射 → 校验 → DuckDB → 指标 → 诊断 → 模拟",
                        "cases": results,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
        finally:
            get_settings.cache_clear()
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


if __name__ == "__main__":
    main()
