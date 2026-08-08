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
from app.imports.synthetic import build_synthetic_csv  # noqa: E402
from app.main import create_app  # noqa: E402
from app.schemas.imports import DataType  # noqa: E402


def mapping_from(parse_payload: dict[str, Any]) -> dict[str, str | None]:
    return {
        str(suggestion["source_column"]): (
            str(suggestion["suggested_field"])
            if suggestion["suggested_field"] is not None
            else None
        )
        for suggestion in parse_payload["suggestions"]
    }


def main() -> None:
    with TemporaryDirectory(prefix="fulfilllens-phase3-demo-") as temporary:
        demo_root = Path(temporary)
        import_root = demo_root / "imports"
        environment = {
            "FL_IMPORT_ROOT": str(import_root),
            "FL_ANALYTICS_DATABASE": str(demo_root / "analytics.duckdb"),
            "FL_CONTROL_DATABASE": str(demo_root / "control.sqlite3"),
            "FL_ENVIRONMENT": "test",
        }
        previous_environment = {key: os.environ.get(key) for key in environment}
        os.environ.update(environment)
        get_settings.cache_clear()
        try:
            with TestClient(create_app()) as client:
                uploaded = client.post(
                    "/api/imports/upload",
                    data={"data_type": DataType.ORDERS.value},
                    files={
                        "file": (
                            "orders-synthetic-phase3.csv",
                            build_synthetic_csv(DataType.ORDERS),
                            "text/csv",
                        )
                    },
                )
                uploaded.raise_for_status()
                upload_payload = uploaded.json()
                task_id = str(upload_payload["task"]["task_id"])

                parsed = client.post(
                    f"/api/imports/{task_id}/parse",
                    json={},
                )
                parsed.raise_for_status()
                parse_payload = parsed.json()

                validated = client.put(
                    f"/api/imports/{task_id}/validation",
                    json={
                        "mapping": mapping_from(parse_payload),
                        "default_timezone": "Asia/Shanghai",
                        "project_status_mappings": {},
                    },
                )
                validated.raise_for_status()
                validation_payload = validated.json()

                confirmed = client.post(f"/api/imports/{task_id}/confirm")
                confirmed.raise_for_status()
                confirm_payload = confirmed.json()

                result = {
                    "input": {
                        "source": "代码生成的完全合成订单 CSV",
                        "data_type": "orders",
                        "rows": parse_payload["total_rows"],
                    },
                    "pipeline": [
                        {
                            "step": "上传",
                            "status": upload_payload["task"]["status"],
                        },
                        {
                            "step": "预览与映射",
                            "status": parse_payload["task"]["status"],
                            "mapped_fields": sum(
                                value is not None for value in mapping_from(parse_payload).values()
                            ),
                        },
                        {
                            "step": "质量校验",
                            "status": validation_payload["task"]["status"],
                            "valid_rows": validation_payload["report"]["valid_rows"],
                            "error_rows": validation_payload["report"]["error_rows"],
                            "unknown_statuses": validation_payload["report"]["unknown_statuses"],
                        },
                        {
                            "step": "确认导入",
                            "status": confirm_payload["task"]["status"],
                            "imported_rows": confirm_payload["imported_rows"],
                            "dataset_id": confirm_payload["dataset_id"],
                        },
                    ],
                    "source_file_removed_after_confirm": not (
                        import_root / task_id / "source.csv"
                    ).exists(),
                    "normalized_dataset_retained": (
                        import_root / task_id / "normalized.jsonl"
                    ).is_file(),
                }
                assert confirm_payload["task"]["status"] == "analyzable"
                assert result["source_file_removed_after_confirm"] is True
                assert result["normalized_dataset_retained"] is True
                print(json.dumps(result, ensure_ascii=False, indent=2))
        finally:
            get_settings.cache_clear()
            for key, previous_value in previous_environment.items():
                if previous_value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = previous_value


if __name__ == "__main__":
    main()
