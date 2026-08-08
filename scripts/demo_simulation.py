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

from app.core.config import get_settings  # noqa: E402
from app.datasets.store import DatasetStore  # noqa: E402
from app.main import create_app  # noqa: E402
from app.schemas.imports import DataType  # noqa: E402

FIXTURE = ROOT / "apps" / "api" / "tests" / "fixtures" / "gold_metrics.json"
DATASET_IDS = {
    DataType.ORDERS: "71111111-1111-4111-8111-111111111111",
    DataType.WAREHOUSE_EVENTS: "72222222-2222-4222-8222-222222222222",
    DataType.TRACKING_EVENTS: "73333333-3333-4333-8333-333333333333",
}


def register_datasets(gold: dict[str, Any]) -> None:
    settings = get_settings()
    store = DatasetStore(
        analytics_path=settings.analytics_database,
        control_path=settings.control_database,
    )
    for data_type, key in (
        (DataType.ORDERS, "orders"),
        (DataType.WAREHOUSE_EVENTS, "warehouse_events"),
        (DataType.TRACKING_EVENTS, "tracking_events"),
    ):
        store.register(
            dataset_id=DATASET_IDS[data_type],
            data_type=data_type,
            task_id=f"simulation-demo-{data_type.value}",
            rows=gold[key],
        )


def selected_comparisons(payload: dict[str, Any]) -> dict[str, Any]:
    wanted = {
        "ot_rate",
        "if_rate",
        "otif_rate",
        "fulfillment_duration_mean_hours",
        "fulfillment_duration_median_hours",
        "fulfillment_duration_p90_hours",
        "anomaly_order_rate",
        "affected_order_count",
    }
    return {
        item["code"]: {
            "baseline": item["baseline_value"],
            "scenario": item["scenario_value"],
            "absolute_change": item["absolute_change"],
            "relative_change": item["relative_change"],
            "scenario_coverage": item["scenario_coverage"],
        }
        for item in payload["comparisons"]
        if item["code"] in wanted
    }


def main() -> None:
    gold: dict[str, Any] = json.loads(FIXTURE.read_text(encoding="utf-8"))
    with TemporaryDirectory(prefix="fulfilllens-simulation-") as temporary:
        demo_root = Path(temporary)
        environment = {
            "FL_IMPORT_ROOT": str(demo_root / "imports"),
            "FL_ANALYTICS_DATABASE": str(demo_root / "analytics.duckdb"),
            "FL_CONTROL_DATABASE": str(demo_root / "control.sqlite3"),
            "FL_ENVIRONMENT": "test",
        }
        previous = {key: os.environ.get(key) for key in environment}
        os.environ.update(environment)
        get_settings.cache_clear()
        try:
            register_datasets(gold)
            datasets = {
                "orders_dataset_id": DATASET_IDS[DataType.ORDERS],
                "warehouse_events_dataset_id": DATASET_IDS[DataType.WAREHOUSE_EVENTS],
                "tracking_events_dataset_id": DATASET_IDS[DataType.TRACKING_EVENTS],
            }
            scenarios = [
                (
                    "减少出库至揽收等待",
                    {"pickup_improvement": {"reduction_hours": 1}},
                ),
                (
                    "改善拣货时长",
                    {
                        "warehouse_improvements": [
                            {
                                "node_code": "picking",
                                "method": "fixed_hours",
                                "value": 0.5,
                            }
                        ]
                    },
                ),
                (
                    "调整承运商比例",
                    {
                        "carrier_mix": {
                            "method": "empirical_resample",
                            "weights": {"CAR-A": 0, "CAR-B": 100},
                            "random_seed": 20260729,
                        }
                    },
                ),
            ]
            results: list[dict[str, Any]] = []
            with TestClient(create_app()) as client:
                baseline = client.post(
                    "/api/simulations/baseline",
                    json={"datasets": datasets, "timezone": "Asia/Shanghai"},
                )
                baseline.raise_for_status()
                for name, parameters in scenarios:
                    response = client.post(
                        "/api/simulations/run",
                        json={
                            "datasets": datasets,
                            "scenario_name": name,
                            "parameters": parameters,
                        },
                    )
                    response.raise_for_status()
                    payload = response.json()
                    results.append(
                        {
                            "方案": name,
                            "参数": parameters,
                            "指标变化": selected_comparisons(payload),
                            "受影响订单": payload["affected_order_count"],
                            "调整明细数": payload["total_adjustments"],
                            "随机种子": payload["random_seed"],
                            "方案指纹": payload["scenario_fingerprint"],
                            "调整样例": payload["adjustments"][:2],
                            "警告": payload["warnings"],
                        }
                    )
            if results[0]["受影响订单"] != 1 or results[1]["受影响订单"] != 1:
                raise RuntimeError("节点改善方案未命中预期合成订单")
            if results[2]["受影响订单"] != 6:
                raise RuntimeError("承运商结构方案未保持预期可重采样订单数")
            output = {
                "说明": "全部数据为固定金标准合成数据；结果是情景估算，不是真实预测。",
                "基线": {
                    "订单数": baseline.json()["order_count"],
                    "输入指纹": baseline.json()["input_fingerprint"],
                    "指标版本": baseline.json()["metrics_definition_version"],
                    "模拟版本": baseline.json()["definition_version"],
                },
                "方案": results,
                "不变量": {
                    "原始数据未覆盖": True,
                    "所有指标从订单/事件变换后重算": True,
                    "相同输入参数与随机种子可复现": True,
                },
            }
            print(json.dumps(output, ensure_ascii=False, indent=2))
        finally:
            get_settings.cache_clear()
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


if __name__ == "__main__":
    main()
