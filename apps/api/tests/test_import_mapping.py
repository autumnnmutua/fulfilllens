from app.imports.contracts import get_contract
from app.imports.mapping import suggest_mappings, validate_mapping
from app.schemas.imports import DataType


def test_alias_matching_exposes_confidence_and_basis() -> None:
    suggestions = suggest_mappings(
        ["订单编号", "下单时间", "订单状态", "完全陌生字段"],
        get_contract(DataType.ORDERS),
    )
    by_source = {item.source_column: item for item in suggestions}

    assert by_source["订单编号"].suggested_field == "order_id"
    assert by_source["订单编号"].confidence == 0.95
    assert by_source["订单编号"].method == "中文别名精确匹配"
    assert by_source["订单状态"].suggested_field == "raw_order_status"
    assert by_source["完全陌生字段"].suggested_field is None


def test_duplicate_target_and_missing_required_fields_are_rejected() -> None:
    contract = get_contract(DataType.ORDERS)
    errors = validate_mapping(
        {
            "订单编号": "order_id",
            "另一个编号": "order_id",
            "订单状态": "raw_order_status",
        },
        ["订单编号", "另一个编号", "订单状态"],
        contract,
    )

    assert any("不能重复映射" in error for error in errors)
    assert any("缺少必填目标字段" in error for error in errors)


def test_raw_status_mapping_satisfies_derived_standard_status() -> None:
    errors = validate_mapping(
        {
            "订单编号": "order_id",
            "创建时间": "created_at",
            "数量": "ordered_quantity",
            "单位": "quantity_unit",
            "状态": "raw_order_status",
        },
        ["订单编号", "创建时间", "数量", "单位", "状态"],
        get_contract(DataType.ORDERS),
    )

    assert errors == []
