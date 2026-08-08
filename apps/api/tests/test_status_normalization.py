from app.imports.statuses import normalize_status, validate_project_mappings
from app.schemas.imports import DataType


def test_builtin_and_unknown_statuses_preserve_raw_value() -> None:
    mapped = normalize_status(DataType.TRACKING_EVENTS, " 快件已揽收 ")
    unknown = normalize_status(DataType.TRACKING_EVENTS, "本地自定义节点")

    assert mapped.raw_status == " 快件已揽收 "
    assert mapped.normalized_status == "carrier_picked_up"
    assert mapped.mapping_source == "builtin_exact"
    assert unknown.normalized_status == "unmapped"
    assert unknown.mapping_confidence == 0


def test_project_mapping_has_priority() -> None:
    mapped = normalize_status(
        DataType.TRACKING_EVENTS,
        "妥投",
        {"妥投": "returned"},
    )

    assert mapped.normalized_status == "returned"
    assert mapped.mapping_source == "project_user"
    assert mapped.mapping_confidence == 1


def test_project_mapping_target_must_be_in_taxonomy() -> None:
    try:
        validate_project_mappings(DataType.ORDERS, {"完成": "invented_status"})
    except ValueError as error:
        assert "invented_status" in str(error)
    else:
        raise AssertionError("无效状态映射应被拒绝")
