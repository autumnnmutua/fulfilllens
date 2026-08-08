from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Response, status

from app.core.config import Settings, get_settings
from app.simulation.models import (
    BaselineRequest,
    BaselineResponse,
    ParameterCatalogResponse,
    ScenarioCopyRequest,
    ScenarioCreate,
    ScenarioRecord,
    ScenarioUpdate,
    SensitivityRequest,
    SensitivityResponse,
    SimulationRequest,
    SimulationResponse,
)
from app.simulation.service import SimulationService

router = APIRouter(prefix="/api/simulations", tags=["What-if 情景模拟"])


def get_simulation_service(
    settings: Annotated[Settings, Depends(get_settings)],
) -> SimulationService:
    return SimulationService(settings)


Service = Annotated[SimulationService, Depends(get_simulation_service)]


@router.get("/parameters", response_model=ParameterCatalogResponse, summary="读取模拟参数目录")
def parameter_catalog(service: Service) -> ParameterCatalogResponse:
    return service.catalog()


@router.post("/baseline", response_model=BaselineResponse, summary="建立当前只读基线")
def simulation_baseline(request: BaselineRequest, service: Service) -> BaselineResponse:
    return service.baseline(request)


@router.get("/scenarios", response_model=list[ScenarioRecord], summary="读取数据集方案")
def list_scenarios(
    service: Service,
    orders_dataset_id: Annotated[str, Query(min_length=36, max_length=36)],
) -> list[ScenarioRecord]:
    return service.list_scenarios(orders_dataset_id)


@router.post(
    "/scenarios",
    response_model=ScenarioRecord,
    status_code=status.HTTP_201_CREATED,
    summary="创建方案",
)
def create_scenario(payload: ScenarioCreate, service: Service) -> ScenarioRecord:
    return service.create_scenario(payload)


@router.patch("/scenarios/{scenario_id}", response_model=ScenarioRecord, summary="重命名或更新方案")
def update_scenario(
    scenario_id: Annotated[str, Path(min_length=36, max_length=36)],
    payload: ScenarioUpdate,
    service: Service,
) -> ScenarioRecord:
    return service.update_scenario(scenario_id, payload)


@router.post(
    "/scenarios/{scenario_id}/copy",
    response_model=ScenarioRecord,
    status_code=status.HTTP_201_CREATED,
    summary="复制方案",
)
def copy_scenario(
    scenario_id: Annotated[str, Path(min_length=36, max_length=36)],
    payload: ScenarioCopyRequest,
    service: Service,
) -> ScenarioRecord:
    return service.copy_scenario(scenario_id, payload)


@router.delete(
    "/scenarios/{scenario_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="删除方案",
)
def delete_scenario(
    scenario_id: Annotated[str, Path(min_length=36, max_length=36)],
    service: Service,
) -> Response:
    service.delete_scenario(scenario_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/run", response_model=SimulationResponse, summary="运行并复算情景方案")
def run_scenario(request: SimulationRequest, service: Service) -> SimulationResponse:
    return service.run(request)


@router.post(
    "/sensitivity",
    response_model=SensitivityResponse,
    summary="执行单参数敏感性分析",
)
def run_sensitivity(
    request: SensitivityRequest,
    service: Service,
) -> SensitivityResponse:
    return service.sensitivity(request)
