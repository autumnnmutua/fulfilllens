from __future__ import annotations

import re
from collections import defaultdict

from app.imports.mapping import normalize_field_name
from app.schemas.imports import SensitiveRisk

SENSITIVE_HEADER_PATTERNS: dict[str, tuple[str, ...]] = {
    "姓名": ("姓名", "收件人", "联系人", "customername", "recipientname", "consignee"),
    "手机号": ("手机号", "手机号码", "联系电话", "电话", "mobile", "phone"),
    "详细地址": ("详细地址", "收货地址", "门牌号", "address", "street"),
    "身份证": ("身份证", "证件号码", "idcard", "identitynumber"),
}
MOBILE_PATTERN = re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")
ID_CARD_PATTERN = re.compile(r"(?<!\d)\d{17}[\dXx](?!\d)")


def detect_sensitive_risks(
    headers: list[str],
    rows: list[dict[str, object]],
) -> list[SensitiveRisk]:
    results: list[SensitiveRisk] = []
    for header in headers:
        normalized_header = normalize_field_name(header)
        categories: set[str] = set()
        basis: set[str] = set()
        for category, patterns in SENSITIVE_HEADER_PATTERNS.items():
            if any(normalize_field_name(pattern) in normalized_header for pattern in patterns):
                categories.add(category)
                basis.add("列名")

        values = [row.get(header) for row in rows[:100]]
        text_values = [str(value) for value in values if value not in {None, ""}]
        if any(MOBILE_PATTERN.search(value) for value in text_values):
            categories.add("手机号")
            basis.add("值模式")
        if any(ID_CARD_PATTERN.search(value) for value in text_values):
            categories.add("身份证")
            basis.add("值模式")

        if categories:
            results.append(
                SensitiveRisk(
                    source_column=header,
                    categories=sorted(categories),
                    detection_basis="+".join(sorted(basis)),
                    non_empty_count=sum(value not in {None, ""} for value in values),
                    message="该列疑似包含个人信息，默认不映射到标准分析字段，预览已隐藏原值。",
                )
            )
    return results


def sensitive_columns(risks: list[SensitiveRisk]) -> set[str]:
    grouped: defaultdict[str, int] = defaultdict(int)
    for risk in risks:
        grouped[risk.source_column] += 1
    return set(grouped)
