from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from app.schemas.imports import DataType, FieldDefinition

PROJECT_ROOT = Path(__file__).resolve().parents[4]
SCHEMA_DIR = PROJECT_ROOT / "data" / "schemas"

SCHEMA_FILES: dict[DataType, str] = {
    DataType.ORDERS: "order.schema.json",
    DataType.WAREHOUSE_EVENTS: "warehouse_event.schema.json",
    DataType.TRACKING_EVENTS: "tracking_event.schema.json",
}

PRIMARY_FIELDS: dict[DataType, str] = {
    DataType.ORDERS: "order_id",
    DataType.WAREHOUSE_EVENTS: "event_id",
    DataType.TRACKING_EVENTS: "tracking_event_id",
}

STATUS_FIELDS: dict[DataType, tuple[str, str]] = {
    DataType.ORDERS: ("raw_order_status", "order_status"),
    DataType.WAREHOUSE_EVENTS: ("raw_status", "event_code"),
    DataType.TRACKING_EVENTS: ("raw_status", "event_code"),
}

FIELD_LABELS: dict[str, str] = {
    "order_id": "订单标识",
    "created_at": "订单创建时间",
    "promised_delivery_time": "承诺交付时间",
    "actual_delivery_time": "实际交付时间",
    "ordered_quantity": "订购数量",
    "delivered_quantity": "累计交付数量",
    "quantity_unit": "数量单位",
    "order_status": "标准订单状态",
    "raw_order_status": "原始订单状态",
    "warehouse_id": "仓库标识",
    "carrier_id": "承运商标识",
    "destination_region": "目的地区",
    "sales_channel": "销售渠道",
    "event_id": "仓库事件标识",
    "event_time": "事件时间",
    "event_code": "标准事件代码",
    "raw_status": "原始状态",
    "quantity": "事件数量",
    "source_system": "来源系统代码",
    "tracking_event_id": "轨迹事件标识",
    "shipment_id": "运单标识",
    "location_code": "节点位置代码",
    "region_code": "区域代码",
    "exception_code": "异常代码",
    "sequence_number": "源事件序号",
}

FIELD_ALIASES: dict[str, tuple[str, ...]] = {
    "order_id": (
        "订单编号",
        "订单号",
        "订单ID",
        "order no",
        "order number",
        "order code",
        "sales order id",
    ),
    "created_at": (
        "下单时间",
        "订单创建时间",
        "创建时间",
        "下单日期",
        "order date",
        "order time",
        "created time",
        "order created at",
    ),
    "promised_delivery_time": (
        "承诺送达时间",
        "承诺交付时间",
        "预计送达时间",
        "promise time",
        "promised date",
        "expected delivery time",
        "sla due time",
    ),
    "actual_delivery_time": (
        "实际送达时间",
        "实际交付时间",
        "签收时间",
        "妥投时间",
        "delivered at",
        "delivery time",
        "signed time",
    ),
    "ordered_quantity": (
        "订购数量",
        "下单数量",
        "订单数量",
        "需求数量",
        "order qty",
        "ordered qty",
        "requested quantity",
    ),
    "delivered_quantity": (
        "交付数量",
        "已交付数量",
        "签收数量",
        "妥投数量",
        "delivered qty",
        "fulfilled qty",
        "received quantity",
    ),
    "quantity_unit": ("数量单位", "单位", "计量单位", "unit", "uom", "qty unit"),
    "order_status": ("标准订单状态", "订单状态代码", "order status code"),
    "raw_order_status": (
        "订单状态",
        "原始订单状态",
        "订单状态名称",
        "order status",
        "status name",
    ),
    "warehouse_id": (
        "仓库编号",
        "仓库编码",
        "仓库ID",
        "仓库",
        "warehouse code",
        "warehouse no",
        "fulfillment center",
    ),
    "carrier_id": (
        "承运商编号",
        "承运商编码",
        "承运商ID",
        "物流公司",
        "carrier code",
        "courier code",
        "logistics provider",
    ),
    "destination_region": ("目的地区", "收货地区", "目的区域", "区域"),
    "sales_channel": ("销售渠道", "订单渠道", "渠道", "销售平台", "channel", "platform"),
    "event_id": (
        "事件编号",
        "仓库事件编号",
        "仓库事件ID",
        "作业事件编号",
        "warehouse event id",
        "operation id",
    ),
    "event_time": (
        "事件时间",
        "作业时间",
        "轨迹时间",
        "扫描时间",
        "event timestamp",
        "scan time",
        "operation time",
    ),
    "event_code": ("标准事件代码", "事件代码", "状态代码"),
    "raw_status": ("物流状态", "仓库状态", "原始状态", "轨迹状态", "作业状态"),
    "quantity": ("事件数量", "作业数量", "处理数量", "数量"),
    "source_system": ("来源系统", "源系统", "数据来源", "source", "source system"),
    "tracking_event_id": (
        "轨迹事件编号",
        "物流事件编号",
        "轨迹事件ID",
        "tracking event id",
        "logistics event id",
        "scan id",
    ),
    "shipment_id": (
        "运单标识",
        "运单编号",
        "运单号",
        "包裹编号",
        "waybill no",
        "tracking no",
        "shipment no",
        "package id",
    ),
    "location_code": ("节点代码", "位置代码", "网点代码", "中转场代码"),
    "region_code": ("区域代码", "地区代码", "行政区代码"),
    "exception_code": ("异常代码", "异常类型", "异常原因代码"),
    "sequence_number": ("事件序号", "轨迹序号", "源序号", "顺序号"),
}


@dataclass(frozen=True)
class Contract:
    data_type: DataType
    schema: dict[str, Any]
    fields: tuple[FieldDefinition, ...]
    primary_field: str
    raw_status_field: str
    normalized_status_field: str


def load_schema(data_type: DataType) -> dict[str, Any]:
    path = SCHEMA_DIR / SCHEMA_FILES[data_type]
    return cast(dict[str, Any], json.loads(path.read_text(encoding="utf-8")))


def describe_schema_type(definition: dict[str, Any]) -> str:
    if "$ref" in definition:
        return "status"
    value_type = definition.get("type")
    if isinstance(value_type, list):
        return "/".join(str(item) for item in value_type if item != "null")
    if "anyOf" in definition:
        types = [
            option.get("type") for option in definition["anyOf"] if option.get("type") != "null"
        ]
        return "/".join(str(item) for item in types)
    return str(value_type or "unknown")


def get_contract(data_type: DataType) -> Contract:
    schema = load_schema(data_type)
    required = set(schema["required"])
    fields = tuple(
        FieldDefinition(
            field=field,
            label=FIELD_LABELS[field],
            required=field in required,
            value_type=describe_schema_type(definition),
            aliases=list(FIELD_ALIASES.get(field, ())),
        )
        for field, definition in schema["properties"].items()
    )
    raw_status_field, normalized_status_field = STATUS_FIELDS[data_type]
    return Contract(
        data_type=data_type,
        schema=schema,
        fields=fields,
        primary_field=PRIMARY_FIELDS[data_type],
        raw_status_field=raw_status_field,
        normalized_status_field=normalized_status_field,
    )
