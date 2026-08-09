from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, Response, UploadFile, status
from fastapi.responses import FileResponse

from app.core.config import Settings, get_settings
from app.imports.service import ImportService
from app.schemas.imports import (
    CompatibilitySampleCatalog,
    ConfirmResponse,
    DataType,
    ImportTaskResponse,
    ParseRequest,
    ParseResponse,
    SyntheticImportRequest,
    UploadResponse,
    ValidationRequest,
    ValidationResponse,
)

router = APIRouter(prefix="/api/imports", tags=["数据导入"])


def get_import_service(
    settings: Annotated[Settings, Depends(get_settings)],
) -> ImportService:
    return ImportService(settings)


@router.get(
    "/samples",
    response_model=CompatibilitySampleCatalog,
    summary="列出完全合成的兼容性导入示例",
)
async def list_compatibility_samples(
    service: Annotated[ImportService, Depends(get_import_service)],
) -> CompatibilitySampleCatalog:
    return service.compatibility_samples()


@router.get(
    "/samples/{sample_id}/file",
    response_class=FileResponse,
    summary="下载完全合成的兼容性导入示例",
)
async def download_compatibility_sample(
    sample_id: str,
    service: Annotated[ImportService, Depends(get_import_service)],
) -> FileResponse:
    sample, path = service.compatibility_sample_path(sample_id)
    media_type = (
        "text/csv; charset=utf-8"
        if sample.file_format.value == "csv"
        else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    return FileResponse(path, media_type=media_type, filename=sample.file_name)


@router.post(
    "/upload",
    response_model=UploadResponse,
    status_code=status.HTTP_201_CREATED,
    summary="安全上传 CSV 或 XLSX",
)
async def upload_import_file(
    data_type: Annotated[DataType, Form()],
    file: Annotated[UploadFile, File()],
    service: Annotated[ImportService, Depends(get_import_service)],
) -> UploadResponse:
    return await service.upload(data_type=data_type, upload=file)


@router.post(
    "/synthetic",
    response_model=ParseResponse,
    status_code=status.HTTP_201_CREATED,
    summary="创建完全合成的导入示例",
)
async def create_synthetic_import(
    request: SyntheticImportRequest,
    service: Annotated[ImportService, Depends(get_import_service)],
) -> ParseResponse:
    return service.create_synthetic(request.data_type)


@router.get(
    "/templates/{data_type}",
    response_class=FileResponse,
    summary="下载标准 CSV 空白模板",
)
async def download_template(
    data_type: DataType,
    service: Annotated[ImportService, Depends(get_import_service)],
) -> FileResponse:
    path = service.template_path(data_type)
    return FileResponse(
        path,
        media_type="text/csv; charset=utf-8",
        filename=path.name,
    )


@router.get(
    "/{task_id}",
    response_model=ImportTaskResponse,
    summary="读取导入任务状态",
)
async def get_import_task(
    task_id: str,
    service: Annotated[ImportService, Depends(get_import_service)],
) -> ImportTaskResponse:
    return service.get_task(task_id).to_response()


@router.post(
    "/{task_id}/parse",
    response_model=ParseResponse,
    summary="选择编码或工作表并生成预览",
)
async def parse_import_file(
    task_id: str,
    request: ParseRequest,
    service: Annotated[ImportService, Depends(get_import_service)],
) -> ParseResponse:
    return service.parse(
        task_id,
        encoding=request.encoding,
        sheet_name=request.sheet_name,
    )


@router.put(
    "/{task_id}/validation",
    response_model=ValidationResponse,
    summary="应用字段和状态映射并生成质量报告",
)
async def validate_import_file(
    task_id: str,
    request: ValidationRequest,
    service: Annotated[ImportService, Depends(get_import_service)],
) -> ValidationResponse:
    return service.validate(task_id, request)


@router.post(
    "/{task_id}/confirm",
    response_model=ConfirmResponse,
    summary="确认导入为可分析数据集",
)
async def confirm_import(
    task_id: str,
    service: Annotated[ImportService, Depends(get_import_service)],
) -> ConfirmResponse:
    return service.confirm(task_id)


@router.get(
    "/{task_id}/errors.csv",
    summary="下载安全转义的错误明细 CSV",
)
async def download_import_errors(
    task_id: str,
    service: Annotated[ImportService, Depends(get_import_service)],
) -> Response:
    content = service.error_csv(task_id)
    return Response(
        content=content,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": (
                f'attachment; filename="fulfilllens-import-errors-{task_id}.csv"'
            )
        },
    )


@router.delete(
    "/{task_id}",
    response_model=ImportTaskResponse,
    summary="取消任务并清理本地数据",
)
async def cancel_import(
    task_id: str,
    service: Annotated[ImportService, Depends(get_import_service)],
) -> ImportTaskResponse:
    return service.cancel(task_id).to_response()
