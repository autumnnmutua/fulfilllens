from __future__ import annotations

from app.core.config import Settings
from app.core.errors import AppError
from app.metrics.service import MetricsService
from app.simulation.engine import build_baseline, run_simulation, sensitivity_analysis
from app.simulation.models import (
    BaselineRequest,
    BaselineResponse,
    ParameterCatalogItem,
    ParameterCatalogResponse,
    ScenarioCopyRequest,
    ScenarioCreate,
    ScenarioParameters,
    ScenarioRecord,
    ScenarioUpdate,
    SensitivityRequest,
    SensitivityResponse,
    SimulationRequest,
    SimulationResponse,
)
from app.simulation.repository import ScenarioRepository

WAREHOUSE_NODE_LABELS = {
    "order_to_pick": "接单后等待拣货",
    "picking": "拣货处理",
    "pick_to_qc": "拣货后等待复核",
    "quality_check": "复核处理",
    "packing": "打包处理",
}


class SimulationService:
    def __init__(self, settings: Settings) -> None:
        self.metrics = MetricsService(settings)
        self.repository = ScenarioRepository(settings.control_database)

    @staticmethod
    def catalog() -> ParameterCatalogResponse:
        return ParameterCatalogResponse(
            parameters=[
                ParameterCatalogItem(
                    code="warehouse_fixed_reduction",
                    display_name="仓内节点固定减少",
                    business_meaning="缩短指定仓内节点的首个完整有效处理区间。",
                    unit="hour",
                    minimum=0,
                    maximum=72,
                    default=0,
                    impact_path="节点结束及其后续事件、实际交付时间等量前移。",
                    model_assumption="节省时间完整传导，不考虑资源排队反弹。",
                ),
                ParameterCatalogItem(
                    code="warehouse_percentage_reduction",
                    display_name="仓内节点比例改善",
                    business_meaning="按原节点时长比例缩短指定仓内处理。",
                    unit="percentage",
                    minimum=0,
                    maximum=100,
                    default=0,
                    impact_path="减少量为原节点时长乘以比例，随后完整传导。",
                    model_assumption="节点时长不会降为负数，最多缩短到零。",
                ),
                ParameterCatalogItem(
                    code="pickup_reduction_hours",
                    display_name="出库至揽收等待减少",
                    business_meaning="模拟增加揽收频次或缩短承运商首次揽收等待。",
                    unit="hour",
                    minimum=0,
                    maximum=168,
                    default=0,
                    impact_path="首次揽收及后续轨迹、实际交付时间等量前移。",
                    model_assumption="不模拟揽收班次、容量和截止时间。",
                ),
                ParameterCatalogItem(
                    code="carrier_weight",
                    display_name="承运商目标占比",
                    business_meaning="改变有承运商历史订单在方案样本中的构成。",
                    unit="weight",
                    minimum=0,
                    maximum=100,
                    default=0,
                    impact_path="按固定种子从各承运商历史联合分布经验重采样。",
                    model_assumption="不控制线路、重量、服务等级或承运商选择偏差。",
                ),
                ParameterCatalogItem(
                    code="promise_extension_hours",
                    display_name="承诺时效放宽",
                    business_meaning="后移订单承诺交付时间，观察服务承诺口径变化。",
                    unit="hour",
                    minimum=0,
                    maximum=168,
                    default=0,
                    impact_path="只调整 promised_delivery_time，仅影响 OT/OTIF。",
                    model_assumption="放宽承诺不等于真实运营改善。",
                ),
            ],
            supported_warehouse_nodes=WAREHOUSE_NODE_LABELS,
        )

    def baseline(self, request: BaselineRequest) -> BaselineResponse:
        orders, warehouse, tracking = self.metrics.load_selection_rows(request.datasets)
        return build_baseline(
            datasets=request.datasets,
            timezone=request.timezone,
            orders=orders,
            warehouse_events=warehouse,
            tracking_events=tracking,
        )

    def list_scenarios(self, orders_dataset_id: str) -> list[ScenarioRecord]:
        return self.repository.list(orders_dataset_id)

    def create_scenario(self, payload: ScenarioCreate) -> ScenarioRecord:
        self.metrics.load_selection_rows(payload.datasets)
        return self.repository.create(payload)

    def update_scenario(
        self,
        scenario_id: str,
        payload: ScenarioUpdate,
    ) -> ScenarioRecord:
        current = self.repository.get(scenario_id)
        updates: dict[str, object] = {}
        if payload.name is not None:
            updates["name"] = payload.name
        if payload.parameters is not None:
            updates["parameters"] = payload.parameters
        return self.repository.update(current.model_copy(update=updates))

    def copy_scenario(
        self,
        scenario_id: str,
        payload: ScenarioCopyRequest,
    ) -> ScenarioRecord:
        source = self.repository.get(scenario_id)
        return self.repository.create(
            ScenarioCreate(
                name=payload.name,
                datasets=source.datasets,
                timezone=source.timezone,
                parameters=source.parameters.model_copy(deep=True),
            )
        )

    def delete_scenario(self, scenario_id: str) -> None:
        self.repository.delete(scenario_id)

    def _resolve_run(
        self,
        request: SimulationRequest,
    ) -> tuple[str | None, str, str, ScenarioParameters]:
        if request.scenario_id is not None:
            record = self.repository.get(request.scenario_id)
            if record.datasets != request.datasets:
                raise AppError(
                    code="SCENARIO_DATASET_MISMATCH",
                    message="方案绑定的数据集与本次请求不一致。",
                    status_code=422,
                )
            scenario_id = record.scenario_id
            scenario_name = record.name
            timezone = record.timezone
            parameters = record.parameters
        else:
            scenario_id = None
            scenario_name = request.scenario_name
            timezone = request.timezone
            if request.parameters is None:
                raise AppError(
                    code="INVALID_SIMULATION_REQUEST",
                    message="临时方案缺少参数。",
                    status_code=422,
                )
            parameters = request.parameters
        return scenario_id, scenario_name, timezone, parameters

    def _run(
        self,
        request: SimulationRequest,
        *,
        order_ids: set[str] | None = None,
    ) -> SimulationResponse:
        scenario_id, scenario_name, timezone, parameters = self._resolve_run(request)
        orders, warehouse, tracking = self.metrics.load_selection_rows(request.datasets)
        if order_ids is not None:
            orders = [row for row in orders if str(row.get("order_id")) in order_ids]
            warehouse = [row for row in warehouse if str(row.get("order_id")) in order_ids]
            tracking = [row for row in tracking if str(row.get("order_id")) in order_ids]
        try:
            return run_simulation(
                scenario_id=scenario_id,
                scenario_name=scenario_name,
                datasets=request.datasets,
                timezone=timezone,
                orders=orders,
                warehouse_events=warehouse,
                tracking_events=tracking,
                parameters=parameters,
                adjustment_detail_limit=request.adjustment_detail_limit,
            )
        except ValueError as error:
            raise AppError(
                code="INVALID_SIMULATION_PARAMETER",
                message=str(error),
                status_code=422,
            ) from error

    def run(self, request: SimulationRequest) -> SimulationResponse:
        return self._run(request)

    def run_for_order_ids(
        self,
        request: SimulationRequest,
        *,
        order_ids: set[str],
    ) -> SimulationResponse:
        return self._run(request, order_ids=order_ids)

    def sensitivity(self, request: SensitivityRequest) -> SensitivityResponse:
        orders, warehouse, tracking = self.metrics.load_selection_rows(request.datasets)
        try:
            return sensitivity_analysis(
                request=request,
                orders=orders,
                warehouse_events=warehouse,
                tracking_events=tracking,
            )
        except ValueError as error:
            raise AppError(
                code="INVALID_SENSITIVITY_PARAMETER",
                message=str(error),
                status_code=422,
            ) from error
