from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime
from threading import Event, RLock
from uuid import UUID, uuid4

from app.core.errors import AppError
from app.reports.models import ReportExportRequest, ReportJob
from app.reports.security import export_filename
from app.reports.service import ReportService


@dataclass
class _JobState:
    public: ReportJob
    cancel_event: Event
    dataset_ids: frozenset[str]
    content: bytes | None = None


class ReportJobManager:
    def __init__(self, *, max_workers: int = 2, max_jobs: int = 100) -> None:
        self._executor = ThreadPoolExecutor(
            max_workers=max_workers,
            thread_name_prefix="fulfilllens-report",
        )
        self._max_jobs = max_jobs
        self._lock = RLock()
        self._jobs: dict[str, _JobState] = {}

    @staticmethod
    def _canonical_job_id(job_id: str) -> str:
        try:
            canonical = str(UUID(job_id))
        except ValueError as error:
            raise AppError(
                code="REPORT_JOB_NOT_FOUND",
                message="报告导出任务不存在。",
                status_code=404,
            ) from error
        if canonical != job_id:
            raise AppError(
                code="REPORT_JOB_NOT_FOUND",
                message="报告导出任务不存在。",
                status_code=404,
            )
        return canonical

    def _prune(self) -> None:
        if len(self._jobs) < self._max_jobs:
            return
        removable = sorted(
            (
                state
                for state in self._jobs.values()
                if state.public.status in {"completed", "failed", "cancelled"}
            ),
            key=lambda state: state.public.updated_at,
        )
        for state in removable[: max(1, len(self._jobs) - self._max_jobs + 1)]:
            self._jobs.pop(state.public.job_id, None)
        if len(self._jobs) >= self._max_jobs:
            raise AppError(
                code="REPORT_EXPORT_QUEUE_FULL",
                message="本机报告任务已达上限，请等待正在运行的任务完成后重试。",
                status_code=429,
            )

    def start(
        self,
        payload: ReportExportRequest,
        *,
        service: ReportService,
        max_export_bytes: int,
    ) -> ReportJob:
        now = datetime.now(UTC)
        job_id = str(uuid4())
        public = ReportJob(
            job_id=job_id,
            status="queued",
            progress=0,
            message="导出任务已排队。",
            format=payload.format,
            csv_kind=payload.csv_kind,
            created_at=now,
            updated_at=now,
        )
        dataset_ids = frozenset(
            value for value in payload.report.datasets.model_dump().values() if value is not None
        )
        state = _JobState(
            public=public,
            cancel_event=Event(),
            dataset_ids=dataset_ids,
        )
        with self._lock:
            self._prune()
            self._jobs[job_id] = state
        self._executor.submit(
            self._run,
            state,
            payload,
            service,
            max_export_bytes,
        )
        return public.model_copy(deep=True)

    def _run(
        self,
        state: _JobState,
        payload: ReportExportRequest,
        service: ReportService,
        max_export_bytes: int,
    ) -> None:
        def update(progress: int, message: str) -> None:
            with self._lock:
                if state.public.status == "cancelled":
                    return
                state.public.status = "running"
                state.public.progress = min(max(progress, state.public.progress), 99)
                state.public.message = message
                state.public.updated_at = datetime.now(UTC)

        try:
            update(2, "导出任务正在运行。")
            if payload.format == "csv":
                if payload.csv_kind is None:
                    raise AppError(
                        code="CSV_KIND_REQUIRED",
                        message="CSV 导出缺少数据类型。",
                        status_code=422,
                    )
                content = service.export_csv(
                    payload.report,
                    kind=payload.csv_kind,
                    progress=update,
                    cancelled=state.cancel_event.is_set,
                )
                suffix = "csv"
                media_type = "text/csv; charset=utf-8"
                label = payload.csv_kind.replace("_", "-")
            else:
                content = service.render_report(
                    payload.report,
                    format_name=payload.format,
                    progress=update,
                    cancelled=state.cancel_event.is_set,
                )
                suffix = "md" if payload.format == "markdown" else "html"
                media_type = (
                    "text/markdown; charset=utf-8"
                    if payload.format == "markdown"
                    else "text/html; charset=utf-8"
                )
                label = "analysis-report"
            if state.cancel_event.is_set():
                raise AppError(
                    code="REPORT_EXPORT_CANCELLED",
                    message="报告导出已取消。",
                    status_code=409,
                )
            if len(content) > max_export_bytes:
                raise AppError(
                    code="REPORT_EXPORT_TOO_LARGE",
                    message="导出文件超过本机安全大小上限，请缩小筛选范围。",
                    status_code=413,
                )
            with self._lock:
                state.content = content
                state.public.status = "completed"
                state.public.progress = 100
                state.public.message = "导出已完成，可以下载。"
                state.public.file_name = export_filename(
                    payload.report.dataset_name,
                    suffix,
                    label=label,
                )
                state.public.media_type = media_type
                state.public.size_bytes = len(content)
                state.public.download_ready = True
                state.public.updated_at = datetime.now(UTC)
        except AppError as error:
            with self._lock:
                cancelled = error.code == "REPORT_EXPORT_CANCELLED"
                state.public.status = "cancelled" if cancelled else "failed"
                state.public.progress = 0 if cancelled else state.public.progress
                state.public.message = error.message
                state.public.error_code = error.code
                state.public.updated_at = datetime.now(UTC)
        except Exception:
            with self._lock:
                state.public.status = "failed"
                state.public.message = "导出失败，请缩小范围后重试或检查本地服务。"
                state.public.error_code = "REPORT_EXPORT_FAILED"
                state.public.updated_at = datetime.now(UTC)

    def get(self, job_id: str) -> ReportJob:
        canonical = self._canonical_job_id(job_id)
        with self._lock:
            state = self._jobs.get(canonical)
            if state is None:
                raise AppError(
                    code="REPORT_JOB_NOT_FOUND",
                    message="报告导出任务不存在或已过期。",
                    status_code=404,
                )
            return state.public.model_copy(deep=True)

    def cancel(self, job_id: str) -> ReportJob:
        canonical = self._canonical_job_id(job_id)
        with self._lock:
            state = self._jobs.get(canonical)
            if state is None:
                raise AppError(
                    code="REPORT_JOB_NOT_FOUND",
                    message="报告导出任务不存在或已过期。",
                    status_code=404,
                )
            if state.public.status not in {"queued", "running"}:
                raise AppError(
                    code="REPORT_JOB_NOT_CANCELLABLE",
                    message="该导出任务已经结束，无法取消。",
                    status_code=409,
                )
            state.cancel_event.set()
            state.public.status = "cancelled"
            state.public.message = "导出已取消。"
            state.public.error_code = "REPORT_EXPORT_CANCELLED"
            state.public.updated_at = datetime.now(UTC)
            return state.public.model_copy(deep=True)

    def download(self, job_id: str) -> tuple[ReportJob, bytes]:
        canonical = self._canonical_job_id(job_id)
        with self._lock:
            state = self._jobs.get(canonical)
            if state is None:
                raise AppError(
                    code="REPORT_JOB_NOT_FOUND",
                    message="报告导出任务不存在或已过期。",
                    status_code=404,
                )
            if state.public.status != "completed" or state.content is None:
                raise AppError(
                    code="REPORT_NOT_READY",
                    message="报告尚未完成，暂时不能下载。",
                    status_code=409,
                )
            return state.public.model_copy(deep=True), state.content

    def purge_for_dataset(self, dataset_id: str) -> int:
        """Cancel and forget in-memory report content tied to a deleted dataset."""
        with self._lock:
            matching = [
                job_id for job_id, state in self._jobs.items() if dataset_id in state.dataset_ids
            ]
            for job_id in matching:
                state = self._jobs.pop(job_id)
                state.cancel_event.set()
                state.content = None
            return len(matching)

    def shutdown(self) -> None:
        self._executor.shutdown(wait=True, cancel_futures=True)


report_jobs = ReportJobManager()
