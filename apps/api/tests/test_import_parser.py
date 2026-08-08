from pathlib import Path

from app.core.config import Settings
from app.imports.parser import (
    detect_csv_encoding,
    list_xlsx_sheets,
    parse_csv,
    parse_xlsx,
)
from openpyxl import Workbook


def settings(tmp_path: Path) -> Settings:
    return Settings(environment="test", import_root=tmp_path / "imports")


def test_utf8_bom_and_gb18030_detection_policy(tmp_path: Path) -> None:
    utf8 = tmp_path / "utf8.csv"
    utf8.write_bytes("\ufeff订单编号\nORD-SYN-1\n".encode("utf-8"))
    gb = tmp_path / "gb.csv"
    gb.write_bytes("订单编号\nORD-SYN-1\n".encode("gb18030"))

    assert detect_csv_encoding(utf8) == ("utf-8-sig", [])
    assert detect_csv_encoding(gb) == (None, ["gb18030", "gbk"])


def test_gb18030_csv_is_only_parsed_after_explicit_selection(tmp_path: Path) -> None:
    path = tmp_path / "orders.csv"
    path.write_bytes("订单编号,订单状态\nORD-SYN-1,已签收\n".encode("gb18030"))

    table = parse_csv(path, encoding="gb18030", settings=settings(tmp_path))

    assert table.headers == ["订单编号", "订单状态"]
    assert table.rows[0].values["订单状态"] == "已签收"


def test_xlsx_sheet_listing_and_formula_non_execution(tmp_path: Path) -> None:
    path = tmp_path / "orders.xlsx"
    workbook = Workbook()
    worksheet = workbook.active
    assert worksheet is not None
    worksheet.title = "订单数据"
    worksheet.append(["订单编号", "订购数量"])
    worksheet.append(["ORD-SYN-1", "=1+1"])
    workbook.create_sheet("说明")
    workbook.save(path)

    sheets = list_xlsx_sheets(path, settings(tmp_path))
    table = parse_xlsx(path, sheet_name="订单数据", settings=settings(tmp_path))

    assert [sheet.name for sheet in sheets] == ["订单数据", "说明"]
    assert table.rows[0].values["订购数量"] is None
    assert table.issues[0].code == "FORMULA_CELL_IGNORED"
    assert table.issues[0].raw_value == "[公式已忽略]"
