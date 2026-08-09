from __future__ import annotations

import json
from pathlib import Path
from typing import cast
from uuid import uuid4

from app.cases.generator import (
    CASE_CONFIGS,
    PRIVACY_STATEMENT,
    generate_case,
    validate_generated_case,
)
from app.cases.models import (
    CASE_GENERATOR_VERSION,
    CaseCatalogResponse,
    CaseId,
    CaseLoadResponse,
    CaseMetadata,
)
from app.core.config import PROJECT_ROOT, Settings
from app.core.errors import AppError
from app.datasets.store import DatasetStore
from app.metrics.models import DatasetSelection
from app.schemas.imports import DataType

CASE_ROOT = PROJECT_ROOT / "data" / "cases"
ALLOWED_CASE_FILES = {
    "orders.csv",
    "warehouse_events.csv",
    "tracking_events.csv",
    "case.xlsx",
    "metadata.json",
}


class CaseService:
    def __init__(self, settings: Settings) -> None:
        self.store = DatasetStore(
            analytics_path=settings.analytics_database,
            control_path=settings.control_database,
        )

    @staticmethod
    def _metadata(case_id: CaseId) -> CaseMetadata:
        path = CASE_ROOT / case_id.value / "metadata.json"
        if not path.is_file():
            raise AppError(
                code="CASE_ARTIFACT_MISSING",
                message="教学案例文件不完整，请重新运行案例生成器。",
                status_code=500,
            )
        payload = cast(dict[str, object], json.loads(path.read_text(encoding="utf-8")))
        return CaseMetadata.model_validate(payload)

    @classmethod
    def catalog(cls) -> CaseCatalogResponse:
        return CaseCatalogResponse(
            cases=[cls._metadata(case_id) for case_id in CaseId],
            generator_version=CASE_GENERATOR_VERSION,
            privacy_statement=PRIVACY_STATEMENT,
        )

    def load(self, case_id: CaseId) -> CaseLoadResponse:
        metadata = self._metadata(case_id)
        generated = generate_case(CASE_CONFIGS[case_id])
        errors = validate_generated_case(generated)
        if errors:
            raise AppError(
                code="CASE_GENERATION_INVALID",
                message="教学案例未通过内部 Schema 与时序校验。",
                status_code=500,
            )
        orders_id = str(uuid4())
        warehouse_id = str(uuid4())
        tracking_id = str(uuid4())
        registrations = (
            (
                orders_id,
                DataType.ORDERS,
                f"case:{case_id.value}:orders:{orders_id}",
                generated.orders,
            ),
            (
                warehouse_id,
                DataType.WAREHOUSE_EVENTS,
                f"case:{case_id.value}:warehouse:{warehouse_id}",
                generated.warehouse_events,
            ),
            (
                tracking_id,
                DataType.TRACKING_EVENTS,
                f"case:{case_id.value}:tracking:{tracking_id}",
                generated.tracking_events,
            ),
        )
        registered_ids: list[str] = []
        try:
            for dataset_id, data_type, task_id, rows in registrations:
                self.store.register(
                    dataset_id=dataset_id,
                    data_type=data_type,
                    task_id=task_id,
                    rows=rows,
                )
                registered_ids.append(dataset_id)
        except Exception:
            for dataset_id in reversed(registered_ids):
                self.store.delete(dataset_id)
            raise
        return CaseLoadResponse(
            case=metadata,
            datasets=DatasetSelection(
                orders_dataset_id=orders_id,
                warehouse_events_dataset_id=warehouse_id,
                tracking_events_dataset_id=tracking_id,
            ),
            message=("案例已载入并设为新的分析上下文；此前数据集仍保留在本机，没有被删除或覆盖。"),
        )

    @staticmethod
    def file_path(case_id: CaseId, file_name: str) -> Path:
        if file_name not in ALLOWED_CASE_FILES:
            raise AppError(
                code="CASE_FILE_NOT_FOUND",
                message="教学案例文件不存在。",
                status_code=404,
            )
        case_dir = (CASE_ROOT / case_id.value).resolve()
        path = (case_dir / file_name).resolve()
        if path.parent != case_dir or not path.is_file():
            raise AppError(
                code="CASE_FILE_NOT_FOUND",
                message="教学案例文件不存在。",
                status_code=404,
            )
        return path

    @staticmethod
    def media_type(file_name: str) -> str:
        if file_name.endswith(".csv"):
            return "text/csv; charset=utf-8"
        if file_name.endswith(".xlsx"):
            return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        return "application/json; charset=utf-8"
