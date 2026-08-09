from __future__ import annotations

import json
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from app.imports.contracts import SCHEMA_DIR
from app.schemas.imports import DataType, StatusNormalizationSummary

WHITESPACE = re.compile(r"\s+")
PUNCTUATION = str.maketrans(
    {
        "，": ",",
        "。": ".",
        "：": ":",
        "；": ";",
        "（": "(",
        "）": ")",
    }
)

BUILTIN_SYNONYMS: dict[DataType, dict[str, str]] = {
    DataType.ORDERS: {
        "订单已创建": "created",
        "已下单": "created",
        "已确认": "confirmed",
        "已审核": "confirmed",
        "处理中": "processing",
        "履约中": "processing",
        "已发货": "shipped",
        "已完成": "delivered",
        "已签收": "delivered",
        "妥投": "delivered",
        "已取消": "cancelled",
        "交易关闭": "cancelled",
        "已退回": "returned",
        "退货完成": "returned",
    },
    DataType.WAREHOUSE_EVENTS: {
        "仓库接单": "order_received",
        "订单已下发": "order_received",
        "开始拣货": "picking_started",
        "拣货中": "picking_started",
        "拣货完成": "picking_completed",
        "配货完成": "picking_completed",
        "开始复核": "quality_check_started",
        "复核中": "quality_check_started",
        "复核失败": "quality_check_failed",
        "质检不通过": "quality_check_failed",
        "复核完成": "quality_check_completed",
        "质检通过": "quality_check_completed",
        "开始打包": "packing_started",
        "打包中": "packing_started",
        "打包完成": "packing_completed",
        "待出库": "ready_to_ship",
        "待揽收": "ready_to_ship",
        "已出库": "shipped_from_warehouse",
        "仓内取消": "warehouse_cancelled",
    },
    DataType.TRACKING_EVENTS: {
        "运单已创建": "shipment_created",
        "已揽件": "carrier_picked_up",
        "快件已揽收": "carrier_picked_up",
        "始发地已发出": "origin_departed",
        "运输中": "in_transit",
        "在途": "in_transit",
        "到达分拨中心": "arrived_at_hub",
        "到达中转场": "arrived_at_hub",
        "离开分拨中心": "departed_hub",
        "发往下一站": "departed_hub",
        "到达目的城市": "arrived_at_destination_city",
        "派送中": "out_for_delivery",
        "正在派件": "out_for_delivery",
        "已签收": "delivered",
        "妥投": "delivered",
        "派送失败": "delivery_failed",
        "未妥投": "delivery_failed",
        "运输异常": "exception",
        "物流异常": "exception",
        "退回中": "return_initiated",
        "已退回": "returned",
        "退回完成": "returned",
    },
}


def normalize_lookup_text(value: object) -> str:
    text = unicodedata.normalize("NFKC", str(value)).translate(PUNCTUATION)
    return WHITESPACE.sub(" ", text).strip().casefold()


def load_status_codes() -> dict[DataType, set[str]]:
    schema = json.loads((SCHEMA_DIR / "status_codes.schema.json").read_text(encoding="utf-8"))
    return {
        DataType.ORDERS: set(schema["$defs"]["orderStatus"]["enum"]),
        DataType.WAREHOUSE_EVENTS: set(schema["$defs"]["warehouseEventCode"]["enum"]),
        DataType.TRACKING_EVENTS: set(schema["$defs"]["trackingEventCode"]["enum"]),
    }


STATUS_CODES = load_status_codes()
NORMALIZED_SYNONYMS: dict[DataType, dict[str, str]] = {
    data_type: {normalize_lookup_text(raw): normalized for raw, normalized in mappings.items()}
    for data_type, mappings in BUILTIN_SYNONYMS.items()
}


@dataclass(frozen=True)
class StatusNormalization:
    raw_status: str
    normalized_status: str
    mapping_source: str
    mapping_confidence: float


def normalize_status(
    data_type: DataType,
    raw_status: object,
    project_mappings: dict[str, str] | None = None,
) -> StatusNormalization:
    raw_text = str(raw_status)
    lookup = normalize_lookup_text(raw_text)
    project = project_mappings or {}
    normalized_project = {normalize_lookup_text(raw): target for raw, target in project.items()}

    if lookup in normalized_project:
        return StatusNormalization(
            raw_status=raw_text,
            normalized_status=normalized_project[lookup],
            mapping_source="project_user",
            mapping_confidence=1.0,
        )
    if lookup in NORMALIZED_SYNONYMS[data_type]:
        return StatusNormalization(
            raw_status=raw_text,
            normalized_status=NORMALIZED_SYNONYMS[data_type][lookup],
            mapping_source="builtin_exact",
            mapping_confidence=0.98,
        )
    if lookup in STATUS_CODES[data_type]:
        return StatusNormalization(
            raw_status=raw_text,
            normalized_status=lookup,
            mapping_source="standard_code",
            mapping_confidence=1.0,
        )
    return StatusNormalization(
        raw_status=raw_text,
        normalized_status="unmapped",
        mapping_source="unmapped",
        mapping_confidence=0.0,
    )


def validate_project_mappings(data_type: DataType, mappings: dict[str, str]) -> None:
    invalid = {
        raw: target
        for raw, target in mappings.items()
        if not normalize_lookup_text(raw) or target not in STATUS_CODES[data_type]
    }
    if invalid:
        invalid_targets = ", ".join(sorted(set(invalid.values())))
        raise ValueError(f"项目状态映射包含无效目标：{invalid_targets}")


def summarize_statuses(
    normalizations: list[StatusNormalization],
) -> list[StatusNormalizationSummary]:
    counts: Counter[tuple[str, str, str, float]] = Counter(
        (
            item.raw_status,
            item.normalized_status,
            item.mapping_source,
            item.mapping_confidence,
        )
        for item in normalizations
    )
    return [
        StatusNormalizationSummary(
            raw_status=raw,
            normalized_status=normalized,
            mapping_source=source,
            mapping_confidence=confidence,
            occurrences=occurrences,
        )
        for (raw, normalized, source, confidence), occurrences in sorted(
            counts.items(),
            key=lambda item: (-item[1], item[0][0]),
        )
    ]


def mappings_path(root: Path) -> Path:
    return root.parent / "project_status_mappings.json"
