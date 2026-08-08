from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

import pytest
from app.core.errors import AppError
from app.imports.security import (
    escape_csv_formula,
    inspect_xlsx_archive,
    sanitize_filename,
    validate_file_signature,
)


def test_filename_is_basename_only_and_extension_is_limited() -> None:
    safe_name, extension = sanitize_filename("../../客户订单.csv")

    assert safe_name == "客户订单.csv"
    assert extension == ".csv"
    with pytest.raises(AppError, match="仅支持"):
        sanitize_filename("payload.xlsm")


def test_csv_rejects_zip_or_legacy_excel_signature(tmp_path: Path) -> None:
    disguised = tmp_path / "orders.csv"
    disguised.write_bytes(b"PK\x03\x04payload")

    with pytest.raises(AppError, match="扩展名不一致"):
        validate_file_signature(disguised, ".csv")


def test_xlsx_rejects_internal_path_traversal(tmp_path: Path) -> None:
    malicious = tmp_path / "malicious.xlsx"
    with ZipFile(malicious, "w", ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("xl/workbook.xml", "<workbook/>")
        archive.writestr("../outside.xml", "<payload/>")

    with pytest.raises(AppError, match="不安全的内部路径"):
        inspect_xlsx_archive(
            malicious,
            max_entries=20,
            max_uncompressed_bytes=1024 * 1024,
        )


def test_xlsx_rejects_macro_or_embedded_binary(tmp_path: Path) -> None:
    malicious = tmp_path / "macro.xlsx"
    with ZipFile(malicious, "w", ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("xl/workbook.xml", "<workbook/>")
        archive.writestr("xl/vbaProject.bin", b"macro")

    with pytest.raises(AppError, match="宏"):
        inspect_xlsx_archive(
            malicious,
            max_entries=20,
            max_uncompressed_bytes=1024 * 1024,
        )


@pytest.mark.parametrize("value", ["=2+2", "+cmd", "-1+2", "@SUM(A1:A2)", "  =1"])
def test_error_csv_formula_prefix_is_escaped(value: str) -> None:
    assert escape_csv_formula(value).startswith("'")
