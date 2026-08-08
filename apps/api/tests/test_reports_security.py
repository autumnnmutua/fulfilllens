from app.imports.security import escape_csv_formula
from app.reports.security import (
    content_disposition,
    export_filename,
    mask_identifier,
    sanitize_export_stem,
)


def test_csv_formula_injection_is_escaped_for_all_dangerous_prefixes() -> None:
    for value in ("=1+1", "+SUM(A1:A2)", "-2+3", "@cmd", '  =HYPERLINK("x")'):
        assert escape_csv_formula(value).startswith("'")
    assert escape_csv_formula("普通中文") == "普通中文"


def test_export_filename_removes_paths_controls_and_reserved_names() -> None:
    assert sanitize_export_stem("../促销/报告\x00") == "促销-报告"
    assert sanitize_export_stem("CON") == "report-CON"
    name = export_filename("促销爆单：2026/06", "html")
    assert "/" not in name and "\\" not in name and name.endswith(".html")
    disposition = content_disposition(name)
    assert "filename*=UTF-8''" in disposition
    assert ".." not in disposition


def test_identifier_mask_keeps_only_short_trace_suffix() -> None:
    assert mask_identifier("SYN-ORDER-000123") == "***0123"
    assert mask_identifier(None) == ""
