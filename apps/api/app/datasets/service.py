from datetime import datetime
from uuid import UUID

from app.core.config import Settings
from app.datasets.models import (
    DatasetDeleteResponse,
    DatasetListResponse,
    DatasetSummary,
)
from app.datasets.store import DatasetRecord, DatasetStore
from app.imports.store import ImportTaskStore
from app.reports.jobs import report_jobs
from app.simulation.repository import ScenarioRepository


def _source_kind(record: DatasetRecord) -> str:
    return "synthetic_case" if record.task_id.startswith("case:") else "user_import"


class DatasetService:
    def __init__(self, settings: Settings) -> None:
        self.datasets = DatasetStore(
            analytics_path=settings.analytics_database,
            control_path=settings.control_database,
        )
        self.imports = ImportTaskStore(
            settings.import_root,
            settings.import_task_ttl_hours,
        )
        self.scenarios = ScenarioRepository(settings.control_database)

    def list(self) -> DatasetListResponse:
        summaries = [
            DatasetSummary(
                dataset_id=record.dataset_id,
                data_type=record.data_type,
                row_count=record.row_count,
                created_at=datetime.fromisoformat(record.created_at),
                source_kind=_source_kind(record),
            )
            for record in self.datasets.list_records()
        ]
        return DatasetListResponse(datasets=summaries, total=len(summaries))

    def delete(self, dataset_id: str) -> DatasetDeleteResponse:
        record, rows_deleted = self.datasets.delete(dataset_id)
        scenarios_deleted = self.scenarios.delete_for_dataset(record.dataset_id)
        report_jobs_deleted = report_jobs.purge_for_dataset(record.dataset_id)
        import_artifacts_deleted = False
        try:
            canonical_task_id = str(UUID(record.task_id))
        except ValueError:
            canonical_task_id = ""
        if canonical_task_id == record.task_id:
            import_artifacts_deleted = self.imports.delete_task_artifacts(record.task_id)
        return DatasetDeleteResponse(
            dataset_id=record.dataset_id,
            data_type=record.data_type,
            rows_deleted=rows_deleted,
            scenarios_deleted=scenarios_deleted,
            report_jobs_deleted=report_jobs_deleted,
            import_artifacts_deleted=import_artifacts_deleted,
            message="本地数据集及其关联缓存已清理，操作不可撤销。",
        )
