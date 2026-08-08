from typing import Annotated

from fastapi import APIRouter, Depends, Path, Response, status

from app.core.config import Settings, get_settings
from app.reports.jobs import report_jobs
from app.reports.models import (
    ReportCapabilities,
    ReportDocument,
    ReportExportRequest,
    ReportJob,
    ReportRequest,
)
from app.reports.security import content_disposition
from app.reports.service import ReportService

router = APIRouter(prefix="/api/reports", tags=["分析报告与安全导出"])


def get_report_service(
    settings: Annotated[Settings, Depends(get_settings)],
) -> ReportService:
    return ReportService(settings)


Service = Annotated[ReportService, Depends(get_report_service)]
SettingsDependency = Annotated[Settings, Depends(get_settings)]
JobId = Annotated[str, Path(min_length=36, max_length=36)]


@router.get("/capabilities", response_model=ReportCapabilities, summary="读取可靠导出能力")
def report_capabilities(settings: SettingsDependency) -> ReportCapabilities:
    return ReportCapabilities(
        supported_formats=["markdown", "html", "csv"],
        csv_export_kinds=[
            "anomaly_orders",
            "data_quality_errors",
            "status_mapping",
            "metric_detail",
            "simulation_comparison",
        ],
        pdf_available=False,
        pdf_reason=(
            "当前未在 Docker 中完成中文字体和 PDF 渲染复现验证；请使用自包含 HTML 的浏览器打印，"
            "但不要把该手工路径视为受支持的 PDF API。"
        ),
        max_export_bytes=settings.max_export_bytes,
    )


@router.post("/preview", response_model=ReportDocument, summary="生成筛选一致的报告预览")
def preview_report(request: ReportRequest, service: Service) -> ReportDocument:
    return service.build_document(request)


@router.post(
    "/jobs",
    response_model=ReportJob,
    status_code=status.HTTP_202_ACCEPTED,
    summary="创建可查询进度和取消的导出任务",
)
def create_report_job(
    request: ReportExportRequest,
    service: Service,
    settings: SettingsDependency,
) -> ReportJob:
    return report_jobs.start(
        request,
        service=service,
        max_export_bytes=settings.max_export_bytes,
    )


@router.get("/jobs/{job_id}", response_model=ReportJob, summary="读取导出进度")
def get_report_job(job_id: JobId) -> ReportJob:
    return report_jobs.get(job_id)


@router.delete("/jobs/{job_id}", response_model=ReportJob, summary="取消导出任务")
def cancel_report_job(job_id: JobId) -> ReportJob:
    return report_jobs.cancel(job_id)


@router.get("/jobs/{job_id}/download", summary="下载已完成的报告或 CSV")
def download_report(job_id: JobId) -> Response:
    job, content = report_jobs.download(job_id)
    if job.file_name is None or job.media_type is None:
        raise RuntimeError("已完成导出缺少文件元数据")
    return Response(
        content=content,
        media_type=job.media_type,
        headers={
            "Content-Disposition": content_disposition(job.file_name),
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": (
                "default-src 'none'; style-src 'unsafe-inline'; img-src data:"
            ),
        },
    )
