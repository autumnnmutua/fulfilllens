from __future__ import annotations

import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from shutil import rmtree
from typing import Any
from uuid import UUID, uuid4

from pydantic import BaseModel, Field

from app.core.errors import AppError
from app.schemas.imports import (
    STATUS_LABELS,
    DataType,
    FileFormat,
    ImportStatus,
    ImportTaskResponse,
    SheetInfo,
)


class ImportTaskRecord(BaseModel):
    task_id: str
    data_type: DataType
    status: ImportStatus
    file_name: str
    file_format: FileFormat
    source_extension: str
    mime_type: str
    created_at: datetime
    updated_at: datetime
    encoding: str | None = None
    encoding_required: bool = False
    encoding_options: list[str] = Field(default_factory=list)
    sheets: list[SheetInfo] = Field(default_factory=list)
    selected_sheet: str | None = None
    default_timezone: str | None = None
    message: str
    mapping: dict[str, str | None] = Field(default_factory=dict)
    ignored_source_columns: list[str] = Field(default_factory=list)
    dataset_id: str | None = None
    warnings: list[str] = Field(default_factory=list)

    def to_response(self) -> ImportTaskResponse:
        return ImportTaskResponse(
            task_id=self.task_id,
            data_type=self.data_type,
            status=self.status,
            status_label=STATUS_LABELS[self.status],
            file_name=self.file_name,
            file_format=self.file_format,
            created_at=self.created_at,
            updated_at=self.updated_at,
            encoding=self.encoding,
            encoding_required=self.encoding_required,
            encoding_options=self.encoding_options,
            sheets=self.sheets,
            selected_sheet=self.selected_sheet,
            default_timezone=self.default_timezone,
            message=self.message,
            can_reconfigure=self.status not in {ImportStatus.ANALYZABLE, ImportStatus.CANCELLED},
        )


class ImportTaskStore:
    def __init__(self, root: Path, ttl_hours: int) -> None:
        self.root = root.resolve()
        self.ttl = timedelta(hours=ttl_hours)
        self.root.mkdir(parents=True, exist_ok=True)
        if os.name != "nt":
            self.root.chmod(0o700)
        self.cleanup_expired()

    def create(
        self,
        *,
        data_type: DataType,
        file_name: str,
        source_extension: str,
        mime_type: str,
    ) -> ImportTaskRecord:
        now = datetime.now(UTC)
        task_id = str(uuid4())
        task_dir = self.task_directory(task_id)
        task_dir.mkdir(mode=0o700)
        record = ImportTaskRecord(
            task_id=task_id,
            data_type=data_type,
            status=ImportStatus.PENDING_UPLOAD,
            file_name=file_name,
            file_format=(FileFormat.CSV if source_extension == ".csv" else FileFormat.XLSX),
            source_extension=source_extension,
            mime_type=mime_type,
            created_at=now,
            updated_at=now,
            message="等待保存上传文件。",
        )
        self.save(record)
        return record

    def task_directory(self, task_id: str) -> Path:
        try:
            canonical = str(UUID(task_id))
        except ValueError as error:
            raise AppError(
                code="IMPORT_TASK_NOT_FOUND",
                message="导入任务不存在。",
                status_code=404,
            ) from error
        if canonical != task_id:
            raise AppError(
                code="IMPORT_TASK_NOT_FOUND",
                message="导入任务不存在。",
                status_code=404,
            )
        path = (self.root / canonical).resolve()
        if path.parent != self.root:
            raise AppError(
                code="UNSAFE_IMPORT_PATH",
                message="导入任务路径无效。",
                status_code=400,
            )
        return path

    def metadata_path(self, task_id: str) -> Path:
        return self.task_directory(task_id) / "task.json"

    def source_path(self, task: ImportTaskRecord) -> Path:
        return self.task_directory(task.task_id) / f"source{task.source_extension}"

    def report_path(self, task_id: str) -> Path:
        return self.task_directory(task_id) / "quality-report.json"

    def normalized_path(self, task_id: str) -> Path:
        return self.task_directory(task_id) / "normalized.jsonl"

    def status_metadata_path(self, task_id: str) -> Path:
        return self.task_directory(task_id) / "status-metadata.jsonl"

    def save(self, record: ImportTaskRecord) -> None:
        record.updated_at = datetime.now(UTC)
        path = self.metadata_path(record.task_id)
        temporary = path.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(record.model_dump(mode="json"), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        temporary.replace(path)
        if os.name != "nt":
            path.chmod(0o600)

    def load(self, task_id: str) -> ImportTaskRecord:
        path = self.metadata_path(task_id)
        if not path.is_file():
            raise AppError(
                code="IMPORT_TASK_NOT_FOUND",
                message="导入任务不存在或已清理。",
                status_code=404,
            )
        return ImportTaskRecord.model_validate_json(path.read_text(encoding="utf-8"))

    def write_json(self, path: Path, value: Any) -> None:
        path.write_text(
            json.dumps(value, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        if os.name != "nt":
            path.chmod(0o600)

    def purge_payload(self, task: ImportTaskRecord, *, keep_normalized: bool) -> None:
        candidates = [
            self.source_path(task),
            self.report_path(task.task_id),
            self.status_metadata_path(task.task_id),
        ]
        if not keep_normalized:
            candidates.append(self.normalized_path(task.task_id))
        for path in candidates:
            path.unlink(missing_ok=True)

    def delete_task_artifacts(self, task_id: str) -> bool:
        directory = self.task_directory(task_id)
        if not directory.exists():
            return False
        if not directory.is_dir() or directory.parent != self.root:
            raise AppError(
                code="UNSAFE_IMPORT_PATH",
                message="导入任务路径无效。",
                status_code=400,
            )
        rmtree(directory)
        return True

    def cleanup_expired(self) -> None:
        cutoff = datetime.now(UTC) - self.ttl
        for directory in self.root.iterdir():
            if not directory.is_dir():
                continue
            metadata = directory / "task.json"
            try:
                task = ImportTaskRecord.model_validate_json(metadata.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if (
                task.updated_at < cutoff
                and task.status not in {ImportStatus.ANALYZABLE}
                and directory.resolve().parent == self.root
            ):
                rmtree(directory)

    def load_project_status_mappings(self, data_type: DataType) -> dict[str, str]:
        path = self.root.parent / "project_status_mappings.json"
        if not path.is_file():
            return {}
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        mappings = payload.get(data_type.value, {})
        return (
            {str(raw): str(target) for raw, target in mappings.items()}
            if isinstance(mappings, dict)
            else {}
        )

    def save_project_status_mappings(
        self,
        data_type: DataType,
        mappings: dict[str, str],
    ) -> None:
        path = self.root.parent / "project_status_mappings.json"
        payload: dict[str, Any] = {}
        if path.is_file():
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    payload = loaded
            except (OSError, json.JSONDecodeError):
                payload = {}
        current = payload.get(data_type.value, {})
        if not isinstance(current, dict):
            current = {}
        current.update(mappings)
        payload[data_type.value] = current
        self.write_json(path, payload)
