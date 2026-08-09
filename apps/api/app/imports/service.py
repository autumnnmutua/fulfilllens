from __future__ import annotations

import csv
import hashlib
import io
import json
import os
from dataclasses import asdict
from pathlib import Path
from uuid import uuid4

from fastapi import UploadFile

from app.core.config import Settings
from app.core.errors import AppError
from app.datasets.store import DatasetStore
from app.imports.contracts import PROJECT_ROOT, get_contract
from app.imports.mapping import detect_data_types, suggest_mappings, validate_mapping
from app.imports.parser import (
    ParsedTable,
    detect_csv_encoding,
    list_xlsx_sheets,
    parse_csv,
    parse_xlsx,
    validate_selected_encoding,
)
from app.imports.privacy import detect_sensitive_risks, sensitive_columns
from app.imports.security import (
    escape_csv_formula,
    mask_sensitive_value,
    sanitize_filename,
    validate_file_signature,
    validate_mime_type,
)
from app.imports.statuses import validate_project_mappings
from app.imports.store import ImportTaskRecord, ImportTaskStore
from app.imports.synthetic import build_synthetic_csv
from app.imports.validation import ValidationArtifacts, validate_import
from app.schemas.imports import (
    CompatibilitySample,
    CompatibilitySampleCatalog,
    ConfirmResponse,
    DataType,
    ImportStatus,
    ParseResponse,
    PreviewRow,
    QualityReport,
    UploadResponse,
    ValidationRequest,
    ValidationResponse,
)
from app.schemas.system import ErrorDetail

UPLOAD_CHUNK_BYTES = 1024 * 1024
SAMPLE_DIR = PROJECT_ROOT / "data" / "samples"
SAMPLE_CATALOG_PATH = SAMPLE_DIR / "compatibility_samples.json"


class ImportService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.store = ImportTaskStore(
            settings.import_root,
            settings.import_task_ttl_hours,
        )
        self.dataset_store = DatasetStore(
            analytics_path=settings.analytics_database,
            control_path=settings.control_database,
        )

    async def upload(self, *, data_type: DataType, upload: UploadFile) -> UploadResponse:
        safe_name, extension = sanitize_filename(upload.filename)
        mime_type = upload.content_type or "application/octet-stream"
        validate_mime_type(extension, mime_type)
        task = self.store.create(
            data_type=data_type,
            file_name=safe_name,
            source_extension=extension,
            mime_type=mime_type,
        )
        source_path = self.store.source_path(task)
        temporary_path = source_path.with_suffix(f"{source_path.suffix}.part")
        size = 0
        try:
            with temporary_path.open("xb") as handle:
                while chunk := await upload.read(UPLOAD_CHUNK_BYTES):
                    size += len(chunk)
                    if size > self.settings.max_upload_bytes:
                        raise AppError(
                            code="UPLOAD_TOO_LARGE",
                            message="文件超过当前 10 MiB 上传上限。",
                            status_code=413,
                        )
                    handle.write(chunk)
            temporary_path.replace(source_path)
            if os.name != "nt":
                source_path.chmod(0o600)
            validate_file_signature(source_path, extension)
            self._prepare_uploaded_task(task)
            return UploadResponse(task=task.to_response())
        except Exception:
            temporary_path.unlink(missing_ok=True)
            self.store.purge_payload(task, keep_normalized=False)
            task.status = ImportStatus.CANCELLED
            task.message = "上传失败，临时文件已清理。"
            self.store.save(task)
            raise
        finally:
            await upload.close()

    def create_synthetic(self, data_type: DataType) -> ParseResponse:
        task = self.store.create(
            data_type=data_type,
            file_name=f"{data_type.value}-synthetic-phase3.csv",
            source_extension=".csv",
            mime_type="text/csv",
        )
        source_path = self.store.source_path(task)
        source_path.write_bytes(build_synthetic_csv(data_type))
        if os.name != "nt":
            source_path.chmod(0o600)
        task.encoding = "utf-8"
        task.encoding_required = False
        task.status = ImportStatus.PARSING
        task.message = "合成示例已生成，正在准备字段映射。"
        self.store.save(task)
        return self.parse(task.task_id, encoding="utf-8", sheet_name=None)

    def _prepare_uploaded_task(self, task: ImportTaskRecord) -> None:
        source_path = self.store.source_path(task)
        if task.source_extension == ".csv":
            encoding, options = detect_csv_encoding(source_path)
            task.encoding = encoding
            task.encoding_options = options
            task.encoding_required = encoding is None
            task.status = (
                ImportStatus.AWAITING_ENCODING if encoding is None else ImportStatus.PARSING
            )
            task.message = (
                "无法可靠区分常见中文编码，请选择 GB18030 或 GBK。"
                if encoding is None
                else f"已可靠识别 {encoding}，可以生成预览。"
            )
        else:
            task.sheets = list_xlsx_sheets(source_path, self.settings)
            if not task.sheets:
                raise AppError(
                    code="XLSX_HAS_NO_WORKSHEETS",
                    message="XLSX 不包含可用工作表。",
                    status_code=422,
                )
            task.status = ImportStatus.AWAITING_SHEET
            task.message = "请选择要导入的工作表。"
        self.store.save(task)

    def get_task(self, task_id: str) -> ImportTaskRecord:
        return self.store.load(task_id)

    def parse(
        self,
        task_id: str,
        *,
        encoding: str | None,
        sheet_name: str | None,
    ) -> ParseResponse:
        task = self.store.load(task_id)
        self._ensure_reconfigurable(task)
        task.status = ImportStatus.PARSING
        task.message = "正在安全解析文件。"
        self.store.save(task)
        table = self._read_table(task, encoding=encoding, sheet_name=sheet_name)
        risks = detect_sensitive_risks(
            table.headers,
            [row.values for row in table.rows],
        )
        suggestions = suggest_mappings(
            table.headers,
            get_contract(task.data_type),
            [row.values for row in table.rows],
        )
        data_type_candidates = detect_data_types(
            table.headers,
            [row.values for row in table.rows],
        )
        detected = data_type_candidates[0]
        warnings = list(table.warnings)
        if detected.data_type != task.data_type:
            selected_label = next(
                item.display_name
                for item in data_type_candidates
                if item.data_type == task.data_type
            )
            warnings.append(
                f"字段结构更像{detected.display_name}（置信度 {detected.confidence:.0%}），"
                f"当前仍按{selected_label}处理；"
                "系统不会静默改变数据类型，请返回第一步复核。"
            )
        task.mapping = {
            suggestion.source_column: suggestion.suggested_field for suggestion in suggestions
        }
        task.status = ImportStatus.AWAITING_MAPPING
        task.message = "预览已就绪，请确认字段映射和默认时区。"
        task.warnings = warnings
        self.store.save(task)

        hidden_columns = sensitive_columns(risks)
        preview_rows = [
            PreviewRow(
                row_number=row.row_number,
                values={
                    header: (
                        mask_sensitive_value(row.values.get(header))
                        if header in hidden_columns
                        else self._preview_value(row.values.get(header))
                    )
                    for header in table.headers
                },
            )
            for row in table.rows[:20]
        ]
        contract = get_contract(task.data_type)
        return ParseResponse(
            task=task.to_response(),
            fields=list(contract.fields),
            source_columns=table.headers,
            preview_rows=preview_rows,
            total_rows=len(table.rows),
            suggestions=suggestions,
            sensitive_risks=risks,
            warnings=warnings,
            detected_data_type=detected.data_type,
            detection_confidence=detected.confidence,
            data_type_candidates=data_type_candidates,
            unmapped_source_columns=[
                suggestion.source_column
                for suggestion in suggestions
                if suggestion.suggested_field is None
            ],
            conversion_notes=[
                "源字段、原始值和行号保持可追溯；自动建议不会在确认前替代人工选择。",
                "文本数字只在目标数量字段通过严格校验后转为数值，空值不会变成 0。",
                "Excel 日期与常见日期文本转为带时区 ISO 8601；无时区值使用用户指定时区。",
                "附加字段默认保持未映射并继续展示，不会为通过校验而删除或改写业务事实。",
            ],
        )

    def compatibility_samples(self) -> CompatibilitySampleCatalog:
        if not SAMPLE_CATALOG_PATH.is_file():
            raise AppError(
                code="COMPATIBILITY_SAMPLE_CATALOG_NOT_FOUND",
                message="兼容性示例目录不存在。",
                status_code=404,
            )
        return CompatibilitySampleCatalog.model_validate_json(
            SAMPLE_CATALOG_PATH.read_text(encoding="utf-8")
        )

    def compatibility_sample_path(self, sample_id: str) -> tuple[CompatibilitySample, Path]:
        catalog = self.compatibility_samples()
        sample = next((item for item in catalog.samples if item.sample_id == sample_id), None)
        if sample is None:
            raise AppError(
                code="COMPATIBILITY_SAMPLE_NOT_FOUND",
                message="兼容性示例不存在。",
                status_code=404,
            )
        sample_root = SAMPLE_DIR.resolve()
        path = (sample_root / sample.file_name).resolve()
        if path.parent != sample_root or not path.is_file():
            raise AppError(
                code="COMPATIBILITY_SAMPLE_FILE_NOT_FOUND",
                message="兼容性示例文件不存在或路径无效。",
                status_code=404,
            )
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != sample.sha256:
            raise AppError(
                code="COMPATIBILITY_SAMPLE_INTEGRITY_FAILED",
                message="兼容性示例完整性校验失败。",
                status_code=500,
            )
        return sample, path

    def validate(
        self,
        task_id: str,
        request: ValidationRequest,
    ) -> ValidationResponse:
        task = self.store.load(task_id)
        self._ensure_reconfigurable(task)
        table = self._read_table(
            task,
            encoding=task.encoding,
            sheet_name=task.selected_sheet,
        )
        contract = get_contract(task.data_type)
        mapping_errors = validate_mapping(
            request.mapping,
            table.headers,
            contract,
            request.ignored_source_columns,
        )
        if mapping_errors:
            raise AppError(
                code="INVALID_FIELD_MAPPING",
                message="字段映射尚不能用于校验。",
                status_code=422,
                details=[
                    ErrorDetail(field="mapping", message=message, type="mapping")
                    for message in mapping_errors
                ],
            )

        try:
            validate_project_mappings(task.data_type, request.project_status_mappings)
        except ValueError as error:
            raise AppError(
                code="INVALID_STATUS_MAPPING",
                message=str(error),
                status_code=422,
            ) from error
        project_mappings = self.store.load_project_status_mappings(task.data_type)
        project_mappings.update(request.project_status_mappings)
        if request.save_project_status_mappings and request.project_status_mappings:
            self.store.save_project_status_mappings(
                task.data_type,
                request.project_status_mappings,
            )

        risks = detect_sensitive_risks(
            table.headers,
            [row.values for row in table.rows],
        )
        artifacts = validate_import(
            table=table,
            contract=contract,
            mapping=request.mapping,
            ignored_source_columns=request.ignored_source_columns,
            default_timezone=request.default_timezone,
            project_status_mappings=project_mappings,
            sensitive_risks=risks,
            max_cell_chars=self.settings.max_cell_chars,
        )
        self._save_validation_artifacts(task, artifacts)
        task.mapping = request.mapping
        task.ignored_source_columns = request.ignored_source_columns
        task.default_timezone = request.default_timezone
        task.status = (
            ImportStatus.READY_TO_CONFIRM
            if artifacts.report.can_confirm
            else ImportStatus.VALIDATION_FAILED
        )
        task.message = (
            "质量校验通过，请确认导入。"
            if artifacts.report.can_confirm
            else "质量校验发现阻断错误；报告已保留，可返回修改映射。"
        )
        self.store.save(task)
        return ValidationResponse(
            task=task.to_response(),
            report=artifacts.report,
            normalized_preview=artifacts.normalized_rows[:10],
        )

    def confirm(self, task_id: str) -> ConfirmResponse:
        task = self.store.load(task_id)
        if task.status != ImportStatus.READY_TO_CONFIRM:
            raise AppError(
                code="IMPORT_NOT_READY",
                message="只有通过质量校验的任务才能确认导入。",
                status_code=409,
            )
        report = self.load_report(task_id)
        normalized_path = self.store.normalized_path(task_id)
        if not report.can_confirm or not normalized_path.is_file():
            raise AppError(
                code="IMPORT_ARTIFACT_MISSING",
                message="导入校验产物缺失，请重新校验。",
                status_code=409,
            )
        task.dataset_id = str(uuid4())
        normalized_rows = self.dataset_store.load_jsonl(normalized_path)
        self.dataset_store.register(
            dataset_id=task.dataset_id,
            data_type=task.data_type,
            task_id=task.task_id,
            rows=normalized_rows,
        )
        task.status = ImportStatus.ANALYZABLE
        task.message = "标准化数据已保存在本机，可以进入后续分析阶段。"
        self.store.source_path(task).unlink(missing_ok=True)
        self.store.save(task)
        return ConfirmResponse(
            task=task.to_response(),
            dataset_id=task.dataset_id,
            imported_rows=report.valid_rows,
            message="导入完成；数据集可供指标引擎按需计算，确认动作本身不会预计算结果。",
        )

    def cancel(self, task_id: str) -> ImportTaskRecord:
        task = self.store.load(task_id)
        if task.status == ImportStatus.ANALYZABLE:
            raise AppError(
                code="CONFIRMED_DATASET_CANNOT_BE_CANCELLED",
                message="已确认数据集不能按未完成任务取消，请使用后续数据集清理功能。",
                status_code=409,
            )
        self.store.purge_payload(task, keep_normalized=False)
        task.status = ImportStatus.CANCELLED
        task.message = "任务已取消，上传和派生数据已从本机清除。"
        task.dataset_id = None
        self.store.save(task)
        return task

    def load_report(self, task_id: str) -> QualityReport:
        path = self.store.report_path(task_id)
        if not path.is_file():
            raise AppError(
                code="QUALITY_REPORT_NOT_FOUND",
                message="该任务尚未生成质量报告。",
                status_code=404,
            )
        return QualityReport.model_validate_json(path.read_text(encoding="utf-8"))

    def error_csv(self, task_id: str) -> bytes:
        report = self.load_report(task_id)
        output = io.StringIO(newline="")
        writer = csv.writer(output, lineterminator="\n")
        writer.writerow(
            [
                "severity",
                "code",
                "sheet",
                "row_number",
                "source_column",
                "target_field",
                "raw_value",
                "message",
                "suggestion",
            ]
        )
        for issue in report.issues:
            writer.writerow(
                [
                    escape_csv_formula(value)
                    for value in (
                        issue.severity.value,
                        issue.code,
                        issue.sheet,
                        issue.row_number,
                        issue.source_column,
                        issue.target_field,
                        issue.raw_value,
                        issue.message,
                        issue.suggestion,
                    )
                ]
            )
        return output.getvalue().encode("utf-8-sig")

    def template_path(self, data_type: DataType) -> Path:
        path = PROJECT_ROOT / "data" / "templates" / f"{data_type.value}.csv"
        if not path.is_file():
            raise AppError(
                code="TEMPLATE_NOT_FOUND",
                message="导入模板不存在。",
                status_code=404,
            )
        return path

    def _read_table(
        self,
        task: ImportTaskRecord,
        *,
        encoding: str | None,
        sheet_name: str | None,
    ) -> ParsedTable:
        source_path = self.store.source_path(task)
        if not source_path.is_file():
            raise AppError(
                code="IMPORT_SOURCE_NOT_FOUND",
                message="源文件已清理或不存在。",
                status_code=409,
            )
        if task.source_extension == ".csv":
            selected = encoding or task.encoding
            if selected is None:
                task.status = ImportStatus.AWAITING_ENCODING
                task.message = "必须先选择 CSV 编码。"
                self.store.save(task)
                raise AppError(
                    code="CSV_ENCODING_REQUIRED",
                    message="无法可靠识别 CSV 编码，请选择 GB18030 或 GBK。",
                    status_code=409,
                )
            task.encoding = validate_selected_encoding(selected)
            task.encoding_required = False
            task.encoding_options = []
            table = parse_csv(source_path, encoding=task.encoding, settings=self.settings)
        else:
            selected_sheet = sheet_name or task.selected_sheet
            if selected_sheet is None:
                if len(task.sheets) == 1:
                    selected_sheet = task.sheets[0].name
                else:
                    task.status = ImportStatus.AWAITING_SHEET
                    task.message = "必须先选择一个工作表。"
                    self.store.save(task)
                    raise AppError(
                        code="WORKSHEET_REQUIRED",
                        message="XLSX 包含多个工作表，请先选择。",
                        status_code=409,
                    )
            task.selected_sheet = selected_sheet
            table = parse_xlsx(
                source_path,
                sheet_name=selected_sheet,
                settings=self.settings,
            )
        self.store.save(task)
        return table

    def _save_validation_artifacts(
        self,
        task: ImportTaskRecord,
        artifacts: ValidationArtifacts,
    ) -> None:
        self.store.write_json(
            self.store.report_path(task.task_id),
            artifacts.report.model_dump(mode="json"),
        )
        normalized_text = "".join(
            f"{json.dumps(row, ensure_ascii=False)}\n" for row in artifacts.normalized_rows
        )
        self.store.normalized_path(task.task_id).write_text(
            normalized_text,
            encoding="utf-8",
        )
        status_text = "".join(
            f"{json.dumps(asdict(row), ensure_ascii=False)}\n" for row in artifacts.status_metadata
        )
        self.store.status_metadata_path(task.task_id).write_text(
            status_text,
            encoding="utf-8",
        )
        if os.name != "nt":
            self.store.normalized_path(task.task_id).chmod(0o600)
            self.store.status_metadata_path(task.task_id).chmod(0o600)

    @staticmethod
    def _preview_value(value: object) -> object:
        if isinstance(value, str) and len(value) > 200:
            return f"{value[:200]}…"
        return value

    @staticmethod
    def _ensure_reconfigurable(task: ImportTaskRecord) -> None:
        if task.status == ImportStatus.CANCELLED:
            raise AppError(
                code="IMPORT_CANCELLED",
                message="已取消任务不能继续处理。",
                status_code=409,
            )
        if task.status == ImportStatus.ANALYZABLE:
            raise AppError(
                code="IMPORT_ALREADY_CONFIRMED",
                message="已确认任务不能修改映射；请新建导入任务。",
                status_code=409,
            )
