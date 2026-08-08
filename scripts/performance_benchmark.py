"""Stage 10 repeatable local benchmark for 10k/50k synthetic orders."""

from __future__ import annotations

import argparse
import csv
import json
import platform
import sys
import tempfile
import threading
import time
from collections.abc import Callable
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, uuid5

import psutil

PROJECT_ROOT = Path(__file__).resolve().parents[1]
API_ROOT = PROJECT_ROOT / "apps" / "api"
sys.path.insert(0, str(API_ROOT))

from app.core.config import Settings  # noqa: E402
from app.datasets.store import DatasetStore  # noqa: E402
from app.diagnostics.models import DiagnosticRequest  # noqa: E402
from app.diagnostics.service import DiagnosticsService  # noqa: E402
from app.imports.parser import parse_csv  # noqa: E402
from app.metrics.models import DatasetSelection  # noqa: E402
from app.metrics.service import MetricsService  # noqa: E402
from app.reports.models import ReportRequest  # noqa: E402
from app.reports.service import ReportService  # noqa: E402
from app.schemas.imports import DataType  # noqa: E402
from app.simulation.models import (  # noqa: E402
    PickupImprovement,
    ScenarioParameters,
    SimulationRequest,
)
from app.simulation.service import SimulationService  # noqa: E402


class PeakRss:
    def __init__(self) -> None:
        self.process = psutil.Process()
        self.peak = self.process.memory_info().rss
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._sample, daemon=True)

    def _sample(self) -> None:
        while not self.stop.wait(0.02):
            self.peak = max(self.peak, self.process.memory_info().rss)

    def __enter__(self) -> PeakRss:
        self.thread.start()
        return self

    def __exit__(self, *_args: object) -> None:
        self.stop.set()
        self.thread.join(timeout=1)
        self.peak = max(self.peak, self.process.memory_info().rss)


def _measure(function: Callable[[], Any]) -> tuple[Any, float]:
    started = time.perf_counter()
    result = function()
    return result, round(time.perf_counter() - started, 3)


def _rows(
    size: int,
) -> tuple[list[dict[str, object]], list[dict[str, object]], list[dict[str, object]]]:
    base = datetime.fromisoformat("2026-01-01T00:00:00+08:00")
    orders: list[dict[str, object]] = []
    warehouse: list[dict[str, object]] = []
    tracking: list[dict[str, object]] = []
    for index in range(size):
        order_id = f"PERF-{index:06d}"
        created = base + timedelta(minutes=index % 43_200)
        shipped = created + timedelta(hours=8 + (index % 5))
        picked_up = shipped + timedelta(hours=2 + (index % 3))
        delivered = created + timedelta(hours=96 if index % 20 == 0 else 48 + index % 12)
        carrier = f"CAR-PERF-{index % 4 + 1}"
        warehouse_id = f"WH-PERF-{index % 3 + 1}"
        orders.append(
            {
                "order_id": order_id,
                "created_at": created.isoformat(),
                "promised_delivery_time": (created + timedelta(hours=72)).isoformat(),
                "actual_delivery_time": delivered.isoformat(),
                "ordered_quantity": 1,
                "delivered_quantity": 1,
                "quantity_unit": "piece",
                "order_status": "delivered",
                "raw_order_status": "delivered",
                "warehouse_id": warehouse_id,
                "carrier_id": carrier,
                "destination_region": f"CN-PERF-{index % 8 + 1}",
                "sales_channel": f"synthetic-{index % 2 + 1}",
            }
        )
        warehouse.append(
            {
                "event_id": f"WH-E-{index:06d}",
                "order_id": order_id,
                "event_time": shipped.isoformat(),
                "event_code": "ready_to_ship",
                "raw_status": "ready_to_ship",
                "warehouse_id": warehouse_id,
                "quantity": 1,
                "quantity_unit": "piece",
                "source_system": "synthetic-performance",
            }
        )
        tracking.append(
            {
                "tracking_event_id": f"TR-E-{index:06d}",
                "order_id": order_id,
                "shipment_id": f"SHIP-{index:06d}",
                "event_time": picked_up.isoformat(),
                "event_code": "carrier_picked_up",
                "raw_status": "carrier_picked_up",
                "carrier_id": carrier,
                "location_code": "CN-PERF-HUB",
                "region_code": f"CN-PERF-{index % 8 + 1}",
                "exception_code": None,
                "sequence_number": 1,
            }
        )
    return orders, warehouse, tracking


def _write_orders_csv(path: Path, rows: list[dict[str, object]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def run_size(size: int) -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix=f"fulfilllens-perf-{size}-") as raw_root:
        root = Path(raw_root)
        settings = Settings(
            environment="test",
            import_root=root / "imports",
            analytics_database=root / "analytics.duckdb",
            control_database=root / "control.sqlite3",
            max_import_rows=max(size, 50_000),
        )
        timings: dict[str, float] = {}
        with PeakRss() as memory:
            (orders, warehouse, tracking), timings["synthetic_generation_seconds"] = _measure(
                lambda: _rows(size)
            )
            csv_path = root / "orders.csv"
            _write_orders_csv(csv_path, orders)
            parsed, timings["csv_parse_seconds"] = _measure(
                lambda: parse_csv(csv_path, encoding="utf-8", settings=settings)
            )
            assert len(parsed.rows) == size and not parsed.issues

            store = DatasetStore(
                analytics_path=settings.analytics_database,
                control_path=settings.control_database,
            )
            ids = {
                "orders": str(uuid5(NAMESPACE_URL, f"fulfilllens-perf-{size}-orders")),
                "warehouse": str(uuid5(NAMESPACE_URL, f"fulfilllens-perf-{size}-warehouse")),
                "tracking": str(uuid5(NAMESPACE_URL, f"fulfilllens-perf-{size}-tracking")),
            }

            def register() -> None:
                store.register(
                    dataset_id=ids["orders"],
                    data_type=DataType.ORDERS,
                    task_id=f"performance:{size}:orders",
                    rows=orders,
                )
                store.register(
                    dataset_id=ids["warehouse"],
                    data_type=DataType.WAREHOUSE_EVENTS,
                    task_id=f"performance:{size}:warehouse",
                    rows=warehouse,
                )
                store.register(
                    dataset_id=ids["tracking"],
                    data_type=DataType.TRACKING_EVENTS,
                    task_id=f"performance:{size}:tracking",
                    rows=tracking,
                )

            _, timings["dataset_import_seconds"] = _measure(register)
            selection = DatasetSelection(
                orders_dataset_id=ids["orders"],
                warehouse_events_dataset_id=ids["warehouse"],
                tracking_events_dataset_id=ids["tracking"],
            )
            summary, timings["metrics_seconds"] = _measure(
                lambda: MetricsService(settings).summary(selection)
            )
            assert next(m for m in summary.metrics if m.code == "order_count").value == size
            diagnostic_request = DiagnosticRequest(datasets=selection)
            diagnostics, timings["diagnostics_seconds"] = _measure(
                lambda: DiagnosticsService(settings).analysis(diagnostic_request)
            )
            parameters = ScenarioParameters(pickup_improvement=PickupImprovement(reduction_hours=1))
            simulation_request = SimulationRequest(
                datasets=selection,
                scenario_name="性能基准",
                parameters=parameters,
                adjustment_detail_limit=20,
            )
            simulation, timings["simulation_seconds"] = _measure(
                lambda: SimulationService(settings).run(simulation_request)
            )
            assert simulation.affected_order_count == size
            report_request = ReportRequest(
                datasets=selection,
                dataset_name=f"{size} 单性能基准",
                sections=[
                    "executive_summary",
                    "metrics_overview",
                    "diagnostics",
                ],
                reading_mode="guided",
            )
            report_bytes, timings["html_export_seconds"] = _measure(
                lambda: ReportService(settings).render_report(
                    report_request,
                    format_name="html",
                    progress=lambda _value, _message: None,
                    cancelled=lambda: False,
                )
            )
            assert b"<!doctype html>" in report_bytes

        return {
            "order_count": size,
            "event_rows": size * 2,
            "csv_bytes": csv_path.stat().st_size,
            "finding_count": diagnostics.context.finding_count,
            "export_bytes": len(report_bytes),
            "timings": timings,
            "peak_rss_mib": round(memory.peak / 1024 / 1024, 1),
        }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sizes", nargs="+", type=int, default=[10_000, 50_000])
    parser.add_argument(
        "--output",
        type=Path,
        default=PROJECT_ROOT / "docs" / "performance-results.json",
    )
    args = parser.parse_args()
    results = {
        "generated_at": datetime.now().astimezone().isoformat(),
        "environment": {
            "platform": platform.platform(),
            "python": platform.python_version(),
            "logical_cpu_count": psutil.cpu_count(),
            "total_memory_gib": round(psutil.virtual_memory().total / 1024**3, 1),
        },
        "budgets": {
            "10000": {"each_core_step_seconds": 20, "peak_rss_mib": 1228.8},
            "50000": {
                "dataset_import_seconds": 60,
                "metrics_seconds": 90,
                "diagnostics_seconds": 120,
                "simulation_seconds": 120,
                "html_export_seconds": 90,
                "peak_rss_mib": 2048,
            },
        },
        "results": [run_size(size) for size in args.sizes],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(results, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
