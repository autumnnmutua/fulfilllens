from __future__ import annotations

import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from app.cases.models import CaseId  # noqa: E402
from app.cases.service import CaseService  # noqa: E402
from app.core.config import Settings  # noqa: E402
from app.reports.models import ReportRequest, ReportSimulationSelection  # noqa: E402
from app.reports.service import ReportService  # noqa: E402
from app.simulation.models import ScenarioParameters  # noqa: E402

OUTPUT_ROOT = ROOT / "data" / "examples"


def main() -> None:
    with TemporaryDirectory(prefix="fulfilllens-report-demo-") as temporary:
        local_root = Path(temporary)
        settings = Settings(
            environment="test",
            import_root=local_root / "imports",
            analytics_database=local_root / "analytics.duckdb",
            control_database=local_root / "control.sqlite3",
        )
        loaded = CaseService(settings).load(CaseId.PROMOTION_SURGE)
        request = ReportRequest(
            datasets=loaded.datasets,
            dataset_name="促销爆单教学案例（完全合成）",
            simulation=ReportSimulationSelection(
                scenario_name="拣货时长改善 15%",
                parameters=ScenarioParameters.model_validate(
                    {
                        "warehouse_improvements": [
                            {
                                "node_code": "picking",
                                "method": "percentage",
                                "value": 15,
                            }
                        ]
                    }
                ),
            ),
        )
        service = ReportService(settings)
        progress_log: list[dict[str, object]] = []

        def progress(value: int, message: str) -> None:
            if not progress_log or progress_log[-1]["progress"] != value:
                progress_log.append({"progress": value, "message": message})

        def not_cancelled() -> bool:
            return False

        OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
        outputs = {
            "markdown": OUTPUT_ROOT / "promotion-surge-report.md",
            "html": OUTPUT_ROOT / "promotion-surge-report.html",
            "csv": OUTPUT_ROOT / "promotion-surge-anomaly-orders.csv",
        }
        outputs["markdown"].write_bytes(
            service.render_report(
                request,
                format_name="markdown",
                progress=progress,
                cancelled=not_cancelled,
            )
        )
        outputs["html"].write_bytes(
            service.render_report(
                request,
                format_name="html",
                progress=progress,
                cancelled=not_cancelled,
            )
        )
        outputs["csv"].write_bytes(
            service.export_csv(
                request,
                kind="anomaly_orders",
                progress=progress,
                cancelled=not_cancelled,
            )
        )
        summary = {
            "privacy": "输入为固定种子的完全合成促销爆单案例，不含真实个人或订单数据。",
            "outputs": {
                name: {
                    "path": str(path.relative_to(ROOT)).replace("\\", "/"),
                    "bytes": path.stat().st_size,
                }
                for name, path in outputs.items()
            },
            "filters": request.filters.model_dump(mode="json"),
            "identifier_policy": "订单标识默认掩码；敏感字段不进入标准报告。",
            "simulation": "拣货时长改善 15%，仅为情景估算。",
            "progress": progress_log,
        }
        print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
