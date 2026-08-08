import csv
import json
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker, ValidationError
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_DIR = ROOT / "data" / "schemas"
TEMPLATE_DIR = ROOT / "data" / "templates"

SCHEMA_FILES = {
    "status": SCHEMA_DIR / "status_codes.schema.json",
    "order": SCHEMA_DIR / "order.schema.json",
    "warehouse": SCHEMA_DIR / "warehouse_event.schema.json",
    "tracking": SCHEMA_DIR / "tracking_event.schema.json",
}


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


SCHEMAS = {name: load_json(path) for name, path in SCHEMA_FILES.items()}
REGISTRY = Registry().with_resources(
    [(schema["$id"], Resource.from_contents(schema)) for schema in SCHEMAS.values()]
)


def validator_for(name: str) -> Draft202012Validator:
    return Draft202012Validator(
        SCHEMAS[name],
        registry=REGISTRY,
        format_checker=FormatChecker(),
    )


VALID_ORDER = {
    "order_id": "ORD-SYN-001",
    "created_at": "2026-07-01T08:00:00+08:00",
    "promised_delivery_time": "2026-07-03T18:00:00+08:00",
    "actual_delivery_time": "2026-07-03T12:00:00+08:00",
    "ordered_quantity": 2,
    "delivered_quantity": 2,
    "quantity_unit": "item",
    "order_status": "delivered",
    "raw_order_status": "已签收",
    "warehouse_id": "WH-SYN-01",
    "carrier_id": "CAR-SYN-01",
    "destination_region": "CN-SYN-EAST",
    "sales_channel": "synthetic_classroom",
}

VALID_WAREHOUSE_EVENT = {
    "event_id": "WE-SYN-001",
    "order_id": "ORD-SYN-001",
    "event_time": "2026-07-01T09:00:00+08:00",
    "event_code": "picking_started",
    "raw_status": "开始拣货",
    "warehouse_id": "WH-SYN-01",
    "quantity": 2,
    "quantity_unit": "item",
    "source_system": "synthetic_generator",
}

VALID_TRACKING_EVENT = {
    "tracking_event_id": "TE-SYN-001",
    "order_id": "ORD-SYN-001",
    "shipment_id": "SHIP-SYN-001",
    "event_time": "2026-07-02T10:00:00+08:00",
    "event_code": "in_transit",
    "raw_status": "运输中",
    "carrier_id": "CAR-SYN-01",
    "location_code": "LOC-SYN-01",
    "region_code": "CN-SYN-EAST",
    "exception_code": None,
    "sequence_number": 3,
}


class SchemaValidationTests(unittest.TestCase):
    def test_all_schemas_are_valid_draft_2020_12(self) -> None:
        for name, schema in SCHEMAS.items():
            with self.subTest(schema=name):
                Draft202012Validator.check_schema(schema)

    def test_valid_synthetic_rows_pass(self) -> None:
        validator_for("order").validate(VALID_ORDER)
        validator_for("warehouse").validate(VALID_WAREHOUSE_EVENT)
        validator_for("tracking").validate(VALID_TRACKING_EVENT)

    def test_missing_required_order_id_fails(self) -> None:
        row = {key: value for key, value in VALID_ORDER.items() if key != "order_id"}
        with self.assertRaises(ValidationError):
            validator_for("order").validate(row)

    def test_wrong_quantity_type_fails(self) -> None:
        row = {**VALID_ORDER, "ordered_quantity": "2"}
        with self.assertRaises(ValidationError):
            validator_for("order").validate(row)

    def test_offsetless_datetime_fails(self) -> None:
        row = {**VALID_ORDER, "created_at": "2026-07-01T08:00:00"}
        with self.assertRaises(ValidationError):
            validator_for("order").validate(row)

    def test_unknown_property_fails(self) -> None:
        row = {**VALID_ORDER, "customer_phone": "not-allowed"}
        with self.assertRaises(ValidationError):
            validator_for("order").validate(row)

    def test_unknown_standard_status_fails(self) -> None:
        row = {**VALID_TRACKING_EVENT, "event_code": "派送途中"}
        with self.assertRaises(ValidationError):
            validator_for("tracking").validate(row)

    def test_unmapped_status_keeps_nonempty_raw_value(self) -> None:
        validator_for("tracking").validate(
            {
                **VALID_TRACKING_EVENT,
                "event_code": "unmapped",
                "raw_status": "本地自定义状态",
            }
        )
        with self.assertRaises(ValidationError):
            validator_for("tracking").validate(
                {
                    **VALID_TRACKING_EVENT,
                    "event_code": "unmapped",
                    "raw_status": "",
                }
            )

    def test_quantity_and_unit_must_appear_together(self) -> None:
        row = {key: value for key, value in VALID_WAREHOUSE_EVENT.items() if key != "quantity_unit"}
        with self.assertRaises(ValidationError):
            validator_for("warehouse").validate(row)

    def test_templates_match_schema_property_order_and_are_empty(self) -> None:
        pairs = {
            "orders.csv": "order",
            "warehouse_events.csv": "warehouse",
            "tracking_events.csv": "tracking",
        }
        for filename, schema_name in pairs.items():
            with self.subTest(template=filename):
                with (TEMPLATE_DIR / filename).open(newline="", encoding="utf-8") as handle:
                    rows = list(csv.reader(handle))
                self.assertEqual(1, len(rows))
                self.assertEqual(
                    list(SCHEMAS[schema_name]["properties"]),
                    rows[0],
                )


if __name__ == "__main__":
    unittest.main()
