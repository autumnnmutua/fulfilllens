from typing import Annotated

from fastapi import APIRouter, Depends, Path

from app.core.config import Settings, get_settings
from app.datasets.models import DatasetDeleteResponse, DatasetListResponse
from app.datasets.service import DatasetService

router = APIRouter(prefix="/api/datasets", tags=["本地数据集与隐私清理"])


def get_dataset_service(
    settings: Annotated[Settings, Depends(get_settings)],
) -> DatasetService:
    return DatasetService(settings)


Service = Annotated[DatasetService, Depends(get_dataset_service)]
DatasetId = Annotated[str, Path(min_length=36, max_length=36)]


@router.get("", response_model=DatasetListResponse, summary="列出本地分析数据集")
def list_datasets(service: Service) -> DatasetListResponse:
    return service.list()


@router.delete(
    "/{dataset_id}",
    response_model=DatasetDeleteResponse,
    summary="不可逆地清理一个本地数据集及关联缓存",
)
def delete_dataset(dataset_id: DatasetId, service: Service) -> DatasetDeleteResponse:
    return service.delete(dataset_id)
