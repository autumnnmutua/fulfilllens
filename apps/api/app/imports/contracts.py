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

_FIELD_CATALOG = json.loads((SCHEMA_DIR / "import_field_catalog.json").read_text(encoding="utf-8"))
FIELD_LABELS: dict[str, str] = {
    str(field): str(label) for field, label in _FIELD_CATALOG["labels"].items()
}
FIELD_ALIASES: dict[str, tuple[str, ...]] = {
    str(field): tuple(str(alias) for alias in aliases)
    for field, aliases in _FIELD_CATALOG["aliases"].items()
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
