from typing import Annotated

from fastapi import APIRouter, Depends, Path, status
from fastapi.responses import FileResponse

from app.cases.models import CaseCatalogResponse, CaseId, CaseLoadResponse
from app.cases.service import CaseService
from app.core.config import Settings, get_settings

router = APIRouter(prefix="/api/cases", tags=["合成数据与教学案例"])


def get_case_service(settings: Annotated[Settings, Depends(get_settings)]) -> CaseService:
    return CaseService(settings)


Service = Annotated[CaseService, Depends(get_case_service)]


@router.get("", response_model=CaseCatalogResponse, summary="读取内置教学案例目录")
def list_cases(service: Service) -> CaseCatalogResponse:
    return service.catalog()


@router.post(
    "/{case_id}/load",
    response_model=CaseLoadResponse,
    status_code=status.HTTP_201_CREATED,
    summary="在本机一键载入完整案例",
)
def load_case(case_id: CaseId, service: Service) -> CaseLoadResponse:
    return service.load(case_id)


@router.get("/{case_id}/files/{file_name}", summary="下载案例 CSV、XLSX 或 metadata")
def download_case_file(
    case_id: CaseId,
    file_name: Annotated[str, Path(min_length=1, max_length=64)],
    service: Service,
) -> FileResponse:
    path = service.file_path(case_id, file_name)
    return FileResponse(path, media_type=service.media_type(file_name), filename=file_name)
