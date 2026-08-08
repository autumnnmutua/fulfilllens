from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from app.core.config import Settings  # noqa: E402
from app.datasets.store import DatasetStore  # noqa: E402
from app.diagnostics.models import DiagnosticRequest  # noqa: E402
from app.diagnostics.service import DiagnosticsService  # noqa: E402
from app.schemas.imports import DataType  # noqa: E402

ORDERS_ID = "81111111-1111-4111-8111-111111111111"
WAREHOUSE_ID = "82222222-2222-4222-8222-222222222222"
TRACKING_ID = "83333333-3333-4333-8333-333333333333"


def order_row(order_id: str, created: datetime, delivered: datetime) -> dict[str, Any]:
    return {
        "order_id": order_id,
        "created_at": created.isoformat(),
        "promised_delivery_time": (created + timedelta(hours=72)).isoformat(),
        "actual_delivery_time": delivered.isoformat(),
        "ordered_quantity": 1,
        "delivered_quantity": 1,
        "quantity_unit": "piece",
        "order_status": "delivered",
        "raw_order_status": "合成已签收",
        "warehouse_id": "WH-SYN",
        "carrier_id": "CAR-SYN",
        "destination_region": "合成华东区",
        "sales_channel": "synthetic",
    }


def warehouse_row(
    event_id: str,
    order_id: str,
    event_time: datetime,
    code: str,
) -> dict[str, Any]:
    return {
        "event_id": event_id,
        "order_id": order_id,
        "event_time": event_time.isoformat(),
        "event_code": code,
        "raw_status": f"合成-{code}",
        "warehouse_id": "WH-SYN",
    }


def tracking_row(
    event_id: str,
    order_id: str,
    event_time: datetime,
    code: str,
) -> dict[str, Any]:
    return {
        "tracking_event_id": event_id,
        "order_id": order_id,
        "shipment_id": f"SYN-{order_id}",
        "event_time": event_time.isoformat(),
        "event_code": code,
        "raw_status": f"合成-{code}",
        "carrier_id": "CAR-SYN",
        "location_code": "SYNTHETIC-NODE",
    }


def build_fixture() -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    base = datetime.fromisoformat("2026-07-01T08:00:00+08:00")
    specs = {
        "SYN-WAREHOUSE": {
            "warehouse_wait": 6.0,
            "pickup_wait": 1.0,
            "destination_wait": 2.0,
            "transit": 30.0,
        },
        "SYN-PICKUP": {
            "warehouse_wait": 1.0,
            "pickup_wait": 14.0,
            "destination_wait": 2.0,
            "transit": 34.0,
        },
        "SYN-LINEHAUL": {
            "warehouse_wait": 1.0,
            "pickup_wait": 1.0,
            "destination_wait": 2.0,
            "transit": 80.0,
        },
        "SYN-LAST-MILE": {
            "warehouse_wait": 1.0,
            "pickup_wait": 1.0,
            "destination_wait": 26.0,
            "transit": 40.0,
        },
        "SYN-DATA": {
            "warehouse_wait": 1.0,
            "pickup_wait": 1.0,
            "destination_wait": 2.0,
            "transit": 28.0,
        },
    }
    orders: list[dict[str, Any]] = []
    warehouse: list[dict[str, Any]] = []
    tracking: list[dict[str, Any]] = []
    for index, (order_id, spec) in enumerate(specs.items()):
        created = base + timedelta(days=index)
        received = created
        picking_started = received + timedelta(hours=spec["warehouse_wait"])
        picking_completed = picking_started + timedelta(hours=1)
        qc_started = picking_completed + timedelta(minutes=15)
        qc_completed = qc_started + timedelta(minutes=30)
        packing_started = qc_completed
        packing_completed = packing_started + timedelta(minutes=30)
        ready = packing_completed
        picked_up = ready + timedelta(hours=spec["pickup_wait"])
        delivered = picked_up + timedelta(hours=spec["transit"])
        arrived = delivered - timedelta(hours=spec["destination_wait"] + 2)
        out_for_delivery = arrived + timedelta(hours=spec["destination_wait"])
        orders.append(order_row(order_id, created, delivered))
        warehouse.extend(
            warehouse_row(f"{order_id}-W-{event_index}", order_id, time, code)
            for event_index, (time, code) in enumerate(
                (
                    (received, "order_received"),
                    (picking_started, "picking_started"),
                    (picking_completed, "picking_completed"),
                    (qc_started, "quality_check_started"),
                    (qc_completed, "quality_check_completed"),
                    (packing_started, "packing_started"),
                    (packing_completed, "packing_completed"),
                    (ready, "ready_to_ship"),
                ),
                start=1,
            )
        )
        tracking.extend(
            tracking_row(f"{order_id}-T-{event_index}", order_id, time, code)
            for event_index, (time, code) in enumerate(
                (
                    (created, "shipment_created"),
                    (picked_up, "carrier_picked_up"),
                    (picked_up + timedelta(hours=1), "origin_departed"),
                    (picked_up + timedelta(hours=2), "in_transit"),
                    (arrived, "arrived_at_destination_city"),
                    (out_for_delivery, "out_for_delivery"),
                    (delivered, "delivered"),
                ),
                start=1,
            )
        )
    duplicate = next(
        item
        for item in tracking
        if item["order_id"] == "SYN-DATA" and item["event_code"] == "in_transit"
    )
    tracking.append(dict(duplicate))
    return orders, warehouse, tracking


def main() -> None:
    orders, warehouse, tracking = build_fixture()
    with TemporaryDirectory(prefix="fulfilllens-diagnostics-") as directory:
        root = Path(directory)
        settings = Settings(
            environment="test",
            import_root=root / "imports",
            analytics_database=root / "analytics.duckdb",
            control_database=root / "control.sqlite3",
        )
        store = DatasetStore(
            analytics_path=settings.analytics_database,
            control_path=settings.control_database,
        )
        for dataset_id, data_type, rows in (
            (ORDERS_ID, DataType.ORDERS, orders),
            (WAREHOUSE_ID, DataType.WAREHOUSE_EVENTS, warehouse),
            (TRACKING_ID, DataType.TRACKING_EVENTS, tracking),
        ):
            store.register(
                dataset_id=dataset_id,
                data_type=data_type,
                task_id=f"synthetic-{data_type.value}",
                rows=rows,
            )
        request = DiagnosticRequest(
            datasets={
                "orders_dataset_id": ORDERS_ID,
                "warehouse_events_dataset_id": WAREHOUSE_ID,
                "tracking_events_dataset_id": TRACKING_ID,
            },
            timezone="Asia/Shanghai",
        )
        service = DiagnosticsService(settings)
        analysis = service.analysis(request)
        required = {"FL-WH-001", "FL-PU-001", "FL-LH-001", "FL-LM-001", "FL-DQ-001"}
        triggered = {item.rule_id for item in analysis.results}
        if not required <= triggered:
            raise RuntimeError(f"合成演示未稳定触发预期规则：{sorted(required - triggered)}")
        order_page = service.orders(
            request,
            page=1,
            page_size=100,
            severity=None,
            category=None,
            rule_id=None,
        )
        detail = service.order_detail(request, order_id="SYN-LAST-MILE")
        output = {
            "说明": "全部数据由脚本生成；诊断为规则判断，不是因果结论。",
            "聚合": {
                "订单数": analysis.context.order_count,
                "受影响订单数": analysis.context.affected_order_count,
                "诊断结果数": analysis.context.finding_count,
                "规则集": analysis.rule_set_version,
                "结果": [
                    {
                        "rule_id": item.rule_id,
                        "title": item.title,
                        "severity": item.severity,
                        "affected_order_count": item.affected_order_count,
                        "factual_observation": item.factual_observation,
                    }
                    for item in analysis.results
                ],
            },
            "对账": {
                "聚合唯一受影响订单": analysis.context.affected_order_count,
                "订单清单总数": order_page.total,
                "一致": analysis.context.affected_order_count == order_page.total,
            },
            "订单追溯": {
                "order_id": detail.metric_detail.order_id,
                "诊断": [
                    {
                        "rule_id": item.rule_id,
                        "fact": item.factual_observation,
                        "evidence_count": len(item.evidence),
                        "recommended_checks": item.recommended_checks,
                    }
                    for item in detail.findings
                ],
                "事件时间线": [
                    {
                        "time": item.event_time,
                        "source": item.source,
                        "event_code": item.event_code,
                    }
                    for item in detail.timeline
                ],
            },
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
