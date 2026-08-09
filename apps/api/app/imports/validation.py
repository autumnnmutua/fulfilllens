from __future__ import annotations

import math
import re
import unicodedata
from collections import Counter, defaultdict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from app.imports.contracts import SCHEMA_DIR, Contract
from app.imports.mapping import normalize_field_variants
from app.imports.parser import ParsedTable, ParseIssue
from app.imports.security import mask_sensitive_value
from app.imports.statuses import (
    StatusNormalization,
    normalize_status,
    summarize_statuses,
)
from app.schemas.imports import (
    IssueSeverity,
    QualityIssue,
    QualityReport,
    SensitiveRisk,
)

DATE_FIELDS = {
    "created_at",
    "promised_delivery_time",
    "actual_delivery_time",
    "event_time",
}
NUMBER_FIELDS = {"ordered_quantity", "delivered_quantity", "quantity"}
INTEGER_FIELDS = {"sequence_number"}
NEGATIVE_CHECKS: dict[str, Callable[[float], bool]] = {
    "ordered_quantity": lambda value: value <= 0,
    "delivered_quantity": lambda value: value < 0,
    "quantity": lambda value: value < 0,
}
COMMON_NAIVE_FORMATS = (
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y/%m/%d %H:%M:%S",
    "%Y/%m/%d %H:%M",
    "%Y-%m-%d",
    "%Y/%m/%d",
    "%Y.%m.%d %H:%M:%S",
    "%Y.%m.%d %H:%M",
    "%Y.%m.%d",
    "%Y年%m月%d日 %H:%M:%S",
    "%Y年%m月%d日 %H:%M",
    "%Y年%m月%d日",
    "%m/%d/%Y %I:%M %p",
    "%m/%d/%Y %I:%M:%S %p",
    "%d-%m-%Y %H:%M",
    "%d-%m-%Y %H:%M:%S",
)
THOUSANDS_PATTERN = re.compile(r"^[+-]?\d{1,3}(,\d{3})+(?:\.\d+)?$")
EXPLICIT_ENGLISH_PATTERN = re.compile(
    r"^(?:[A-Za-z]{3}\s+)?(?P<month>[A-Za-z]{3})\s+(?P<day>\d{1,2})\s+"
    r"(?P<year>\d{4})\s+(?P<hour>\d{2}):(?P<minute>\d{2}):(?P<second>\d{2})\s+"
    r"GMT(?P<sign>[+-])(?P<offset_hour>\d{2})(?P<offset_minute>\d{2})"
    r"(?:\s+\([^)]*\))?$"
)
ENGLISH_MONTHS = {
    month: index
    for index, month in enumerate(
        ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"),
        start=1,
    )
}
NO_EXCEPTION_VALUES = {"", "0", "n", "正常", "无", "-", "常规"}
KNOWN_EXCEPTION_CODES = {
    "WEATHER_DELAY",
    "CALL_FAIL",
    "ADDR_UNCLEAR",
    "CANCELLED",
    "RETURNING",
    "RETURN_DONE",
}


class ValueParseError(ValueError):
    def __init__(self, code: str, message: str, suggestion: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.suggestion = suggestion


@dataclass(frozen=True)
class StatusMetadataRow:
    row_number: int
    raw_status: str
    normalized_status: str
    mapping_source: str
    mapping_confidence: float


@dataclass(frozen=True)
class ValidationArtifacts:
    report: QualityReport
    normalized_rows: list[dict[str, Any]]
    status_metadata: list[StatusMetadataRow]


class IssueCollector:
    def __init__(self, sensitive_columns: set[str]) -> None:
        self.issues: list[QualityIssue] = []
        self.sensitive_columns = sensitive_columns

    def add(
        self,
        *,
        severity: IssueSeverity,
        code: str,
        message: str,
        suggestion: str,
        sheet: str | None = None,
        row_number: int | None = None,
        source_column: str | None = None,
        target_field: str | None = None,
        raw_value: object = None,
    ) -> None:
        safe_raw: str | None
        if source_column in self.sensitive_columns:
            safe_raw = mask_sensitive_value(raw_value)
        elif raw_value is None:
            safe_raw = None
        else:
            safe_raw = str(raw_value)[:200]
        location = target_field or source_column or "-"
        issue_id = f"{code}:{row_number or 0}:{location}:{len(self.issues) + 1}"
        self.issues.append(
            QualityIssue(
                issue_id=issue_id,
                severity=severity,
                code=code,
                message=message,
                sheet=sheet,
                row_number=row_number,
                source_column=source_column,
                target_field=target_field,
                raw_value=safe_raw,
                suggestion=suggestion,
            )
        )


def build_validator(contract: Contract) -> Draft202012Validator:
    status_schema = __import__("json").loads(
        (SCHEMA_DIR / "status_codes.schema.json").read_text(encoding="utf-8")
    )
    registry = Registry().with_resources(
        [
            (
                status_schema["$id"],
                Resource.from_contents(status_schema),
            ),
            (
                contract.schema["$id"],
                Resource.from_contents(contract.schema),
            ),
        ]
    )
    return Draft202012Validator(
        contract.schema,
        registry=registry,
        format_checker=FormatChecker(),
    )


def is_empty(value: object) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def parse_number(value: object, *, integer: bool) -> int | float:
    if isinstance(value, bool):
        raise ValueParseError(
            "UNPARSEABLE_NUMBER",
            "布尔值不能作为数量。",
            "改为明确的数字。",
        )
    if isinstance(value, int):
        decimal = Decimal(value)
    elif isinstance(value, float):
        if not math.isfinite(value):
            raise ValueParseError(
                "UNPARSEABLE_NUMBER",
                "NaN 或无穷大不是有效数量。",
                "改为有限十进制数字。",
            )
        decimal = Decimal(str(value))
    else:
        text = unicodedata.normalize("NFKC", str(value)).strip()
        if "," in text:
            if not THOUSANDS_PATTERN.fullmatch(text):
                raise ValueParseError(
                    "AMBIGUOUS_NUMBER_FORMAT",
                    "数字中的逗号无法确定是千分位还是小数分隔符。",
                    "使用小数点，并只按 1,234.56 形式使用千分位。",
                )
            text = text.replace(",", "")
        try:
            decimal = Decimal(text)
        except InvalidOperation as error:
            raise ValueParseError(
                "UNPARSEABLE_NUMBER",
                "无法解析为数字。",
                "改为有限十进制数字，不要带单位文字。",
            ) from error
    if not decimal.is_finite():
        raise ValueParseError(
            "UNPARSEABLE_NUMBER",
            "NaN 或无穷大不是有效数量。",
            "改为有限十进制数字。",
        )
    if integer:
        if decimal != decimal.to_integral_value():
            raise ValueParseError(
                "UNPARSEABLE_INTEGER",
                "该字段必须是整数。",
                "去除小数部分或修正字段映射。",
            )
        return int(decimal)
    if decimal == decimal.to_integral_value():
        return int(decimal)
    return float(decimal)


def attach_timezone(value: datetime, timezone_name: str | None) -> datetime:
    if value.tzinfo is not None:
        return value
    if not timezone_name:
        raise ValueParseError(
            "TIMEZONE_REQUIRED",
            "时间不含时区，必须指定默认 IANA 时区。",
            "选择例如 Asia/Shanghai 后重新校验。",
        )
    try:
        timezone = ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError as error:
        raise ValueParseError(
            "INVALID_TIMEZONE",
            "默认时区不是可用的 IANA 时区。",
            "选择例如 Asia/Shanghai。",
        ) from error

    valid_candidates: list[datetime] = []
    for fold in (0, 1):
        candidate = value.replace(tzinfo=timezone, fold=fold)
        round_trip = candidate.astimezone(UTC).astimezone(timezone).replace(tzinfo=None)
        if round_trip == value:
            valid_candidates.append(candidate)
    unique_offsets = {candidate.utcoffset() for candidate in valid_candidates}
    if not valid_candidates:
        raise ValueParseError(
            "NONEXISTENT_LOCAL_TIME",
            "该本地时间位于夏令时跳变缺口。",
            "使用带明确 UTC 偏移的 ISO 8601 时间。",
        )
    if len(unique_offsets) > 1:
        raise ValueParseError(
            "AMBIGUOUS_LOCAL_TIME",
            "该本地时间在夏令时回拨时出现两次。",
            "使用带明确 UTC 偏移的 ISO 8601 时间。",
        )
    return valid_candidates[0]


def parse_datetime_value(value: object, timezone_name: str | None) -> str:
    text = unicodedata.normalize("NFKC", str(value)).strip()
    parsed: datetime | None = None
    explicit = EXPLICIT_ENGLISH_PATTERN.fullmatch(text)
    if explicit:
        offset_minutes = int(explicit["offset_hour"]) * 60 + int(explicit["offset_minute"])
        if explicit["sign"] == "-":
            offset_minutes = -offset_minutes
        month = ENGLISH_MONTHS.get(explicit["month"].casefold())
        if month is not None:
            try:
                parsed = datetime(
                    int(explicit["year"]),
                    month,
                    int(explicit["day"]),
                    int(explicit["hour"]),
                    int(explicit["minute"]),
                    int(explicit["second"]),
                    tzinfo=timezone(timedelta(minutes=offset_minutes)),
                )
            except ValueError:
                parsed = None
    try:
        if parsed is None:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        for date_format in COMMON_NAIVE_FORMATS:
            try:
                parsed = datetime.strptime(text, date_format)
                break
            except ValueError:
                continue
    if parsed is None:
        raise ValueParseError(
            "INVALID_TIME",
            "无法解析时间。",
            "使用带时区 ISO 8601，例如 2026-07-01T08:00:00+08:00。",
        )
    return attach_timezone(parsed, timezone_name).isoformat()


def parse_text(value: object) -> str:
    return unicodedata.normalize("NFKC", str(value)).strip()


def normalize_exception_code(value: object) -> tuple[str | None, bool]:
    raw = parse_text(value)
    if raw.casefold() in NO_EXCEPTION_VALUES:
        return None, False
    if raw == "1":
        return "GENERIC_EXCEPTION", True
    code = re.sub(r"[^A-Z0-9]+", "_", raw.upper()).strip("_")
    if not code:
        return "GENERIC_EXCEPTION", True
    return code, code not in KNOWN_EXCEPTION_CODES


def generated_tracking_event_id(record: dict[str, Any], row_number: int) -> str | None:
    required = [
        parse_text(record.get("order_id", "")),
        parse_text(record.get("shipment_id", "")),
        parse_text(record.get("event_time", "")),
        parse_text(record.get("raw_status", "")),
        parse_text(record.get("carrier_id", "")),
    ]
    if any(not value for value in required):
        return None
    canonical = "\x1f".join(
        [*required, parse_text(record.get("sequence_number", "")), str(row_number)]
    )
    hash_value = 0x811C9DC5
    for byte in canonical.encode("utf-8"):
        hash_value ^= byte
        hash_value = (hash_value * 0x01000193) & 0xFFFFFFFF
    return f"TRE-GEN-{row_number:06d}-{hash_value:08X}"


def parse_field_value(field: str, value: object, timezone_name: str | None) -> Any:
    if field in DATE_FIELDS:
        return parse_datetime_value(value, timezone_name)
    if field in NUMBER_FIELDS:
        return parse_number(value, integer=False)
    if field in INTEGER_FIELDS:
        return parse_number(value, integer=True)
    return parse_text(value)


def to_utc(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)
    except ValueError:
        return None


def issue_from_parse(
    collector: IssueCollector,
    issue: ParseIssue,
    sheet_name: str | None,
) -> None:
    collector.add(
        severity=(IssueSeverity.ERROR if issue.severity == "error" else IssueSeverity.WARNING),
        code=issue.code,
        message=issue.message,
        suggestion=issue.suggestion,
        sheet=sheet_name,
        row_number=issue.row_number,
        source_column=issue.source_column,
        raw_value=issue.raw_value,
    )


def validate_import(
    *,
    table: ParsedTable,
    contract: Contract,
    mapping: dict[str, str | None],
    ignored_source_columns: list[str] | None = None,
    default_timezone: str | None,
    project_status_mappings: dict[str, str],
    sensitive_risks: list[SensitiveRisk],
    max_cell_chars: int,
) -> ValidationArtifacts:
    sensitive = {risk.source_column for risk in sensitive_risks}
    collector = IssueCollector(sensitive)
    for issue in table.issues:
        issue_from_parse(collector, issue, table.sheet_name)

    ignored_sources = set(ignored_source_columns or [])
    target_to_source = {
        target: source
        for source, target in mapping.items()
        if target is not None and source not in ignored_sources
    }
    auxiliary_sources: dict[str, str] = {}
    for purpose, aliases in contract.auxiliary_aliases.items():
        normalized_aliases = {
            variant for alias in aliases for variant in normalize_field_variants(alias)
        }
        source = next(
            (
                header
                for header in table.headers
                if set(normalize_field_variants(header)) & normalized_aliases
            ),
            None,
        )
        if source is not None:
            auxiliary_sources[purpose] = source
    derive_tracking_event_id = (
        contract.data_type.value == "tracking_events"
        and "tracking_event_id" not in target_to_source
    )
    if derive_tracking_event_id:
        collector.add(
            severity=IssueSeverity.INFO,
            code="GENERATED_TRACKING_EVENT_ID",
            message="源文件没有可信的轨迹事件唯一标识，系统将按语义字段与源行号生成稳定 ID。",
            suggestion="如源系统提供真实且唯一的事件 ID，可返回映射步骤人工选择。",
            target_field="tracking_event_id",
        )
    validator = build_validator(contract)
    null_counts: Counter[str] = Counter()
    candidate_rows: list[tuple[int, dict[str, Any], StatusNormalization | None]] = []

    for parsed_row in table.rows:
        record: dict[str, Any] = {}
        status_normalization: StatusNormalization | None = None
        for definition in contract.fields:
            field = definition.field
            source = target_to_source.get(field)
            value = parsed_row.values.get(source) if source is not None else None
            if is_empty(value):
                null_counts[field] += 1
                if (
                    definition.required
                    and not (derive_tracking_event_id and field == "tracking_event_id")
                    and field
                    not in {
                        contract.raw_status_field,
                        contract.normalized_status_field,
                    }
                ):
                    collector.add(
                        severity=IssueSeverity.ERROR,
                        code="REQUIRED_VALUE_MISSING",
                        message="必填字段为空。",
                        suggestion="补充原值或修改字段映射。",
                        sheet=table.sheet_name,
                        row_number=parsed_row.row_number,
                        source_column=source,
                        target_field=field,
                    )
                continue
            if isinstance(value, str) and len(value) > max_cell_chars:
                collector.add(
                    severity=IssueSeverity.ERROR,
                    code="LONG_TEXT_VALUE",
                    message="文本长度超过当前安全上限。",
                    suggestion=f"将文本缩短到 {max_cell_chars} 字符以内。",
                    sheet=table.sheet_name,
                    row_number=parsed_row.row_number,
                    source_column=source,
                    target_field=field,
                    raw_value=value,
                )
            try:
                if field == "exception_code":
                    normalized_exception, warning = normalize_exception_code(value)
                    record[field] = normalized_exception
                    if warning:
                        collector.add(
                            severity=IssueSeverity.WARNING,
                            code="GENERIC_OR_UNKNOWN_EXCEPTION",
                            message=(
                                "异常标记缺少可验证的具体语义，已透明保留为通用或规范化代码。"
                            ),
                            suggestion="核对源系统异常字典；系统不会编造具体异常原因。",
                            sheet=table.sheet_name,
                            row_number=parsed_row.row_number,
                            source_column=source,
                            target_field=field,
                            raw_value=value,
                        )
                else:
                    record[field] = parse_field_value(field, value, default_timezone)
            except ValueParseError as error:
                collector.add(
                    severity=IssueSeverity.ERROR,
                    code=error.code,
                    message=error.message,
                    suggestion=error.suggestion,
                    sheet=table.sheet_name,
                    row_number=parsed_row.row_number,
                    source_column=source,
                    target_field=field,
                    raw_value=value,
                )

        raw_field = contract.raw_status_field
        normalized_field = contract.normalized_status_field
        raw_source = target_to_source.get(raw_field) or target_to_source.get(normalized_field)
        raw_value = parsed_row.values.get(raw_source) if raw_source is not None else None
        if not is_empty(raw_value):
            status_normalization = normalize_status(
                contract.data_type,
                raw_value,
                project_status_mappings,
                {
                    purpose: parsed_row.values.get(source)
                    for purpose, source in auxiliary_sources.items()
                },
            )
            record[raw_field] = status_normalization.raw_status
            record[normalized_field] = status_normalization.normalized_status
            if status_normalization.normalized_status == "unmapped":
                collector.add(
                    severity=IssueSeverity.WARNING,
                    code="UNKNOWN_STATUS",
                    message="原始状态无法可靠映射，已保留并标记为 unmapped。",
                    suggestion="选择标准状态并保存项目级映射后重新校验。",
                    sheet=table.sheet_name,
                    row_number=parsed_row.row_number,
                    source_column=raw_source,
                    target_field=normalized_field,
                    raw_value=raw_value,
                )
        else:
            collector.add(
                severity=IssueSeverity.ERROR,
                code="REQUIRED_STATUS_MISSING",
                message="原始状态为空，无法生成标准状态。",
                suggestion="映射一个含原始业务状态的列。",
                sheet=table.sheet_name,
                row_number=parsed_row.row_number,
                source_column=raw_source,
                target_field=raw_field,
            )

        if derive_tracking_event_id:
            generated_id = generated_tracking_event_id(record, parsed_row.row_number)
            if generated_id is not None:
                record["tracking_event_id"] = generated_id

        for field, check in NEGATIVE_CHECKS.items():
            value = record.get(field)
            if isinstance(value, (int, float)) and check(value):
                collector.add(
                    severity=IssueSeverity.ERROR,
                    code="NEGATIVE_OR_INVALID_QUANTITY",
                    message="数量不符合业务约束。",
                    suggestion=("订购数量必须大于 0；交付和事件数量必须大于等于 0。"),
                    sheet=table.sheet_name,
                    row_number=parsed_row.row_number,
                    source_column=target_to_source.get(field),
                    target_field=field,
                    raw_value=value,
                )

        created = to_utc(record.get("created_at"))
        promised = to_utc(record.get("promised_delivery_time"))
        actual = to_utc(record.get("actual_delivery_time"))
        for field, event_time in (
            ("promised_delivery_time", promised),
            ("actual_delivery_time", actual),
        ):
            if created is not None and event_time is not None and event_time < created:
                collector.add(
                    severity=IssueSeverity.ERROR,
                    code="TIME_ORDER_CONFLICT",
                    message="业务时间早于订单创建时间。",
                    suggestion="修正时间、时区或字段映射。",
                    sheet=table.sheet_name,
                    row_number=parsed_row.row_number,
                    source_column=target_to_source.get(field),
                    target_field=field,
                    raw_value=record.get(field),
                )

        for schema_error in sorted(
            validator.iter_errors(record),
            key=lambda item: list(item.path),
        ):
            schema_field = str(schema_error.path[0]) if schema_error.path else None
            collector.add(
                severity=IssueSeverity.ERROR,
                code="SCHEMA_VALIDATION_ERROR",
                message=schema_error.message,
                suggestion="按数据字典修正字段类型、长度、必填性或状态代码。",
                sheet=table.sheet_name,
                row_number=parsed_row.row_number,
                source_column=(target_to_source.get(schema_field) if schema_field else None),
                target_field=schema_field,
                raw_value=record.get(schema_field) if schema_field else None,
            )
        candidate_rows.append((parsed_row.row_number, record, status_normalization))

    primary_groups: defaultdict[str, list[tuple[int, dict[str, Any]]]] = defaultdict(list)
    for row_number, record, _ in candidate_rows:
        primary = record.get(contract.primary_field)
        if primary is not None:
            primary_groups[str(primary)].append((row_number, record))

    excluded_exact_rows: set[int] = set()
    duplicate_conflict_rows: set[int] = set()
    duplicate_keys = 0
    for key, rows in primary_groups.items():
        if len(rows) < 2:
            continue
        duplicate_keys += 1
        first_record = rows[0][1]
        if all(record == first_record for _, record in rows[1:]):
            for row_number, _ in rows[1:]:
                excluded_exact_rows.add(row_number)
                collector.add(
                    severity=IssueSeverity.WARNING,
                    code="EXACT_DUPLICATE_ROW",
                    message="该主键记录与前一行完全相同，确认时只保留第一行。",
                    suggestion="可以删除重复行以提高数据清晰度。",
                    sheet=table.sheet_name,
                    row_number=row_number,
                    target_field=contract.primary_field,
                    raw_value=key,
                )
        else:
            for row_number, _ in rows:
                duplicate_conflict_rows.add(row_number)
                collector.add(
                    severity=IssueSeverity.ERROR,
                    code="DUPLICATE_KEY_CONFLICT",
                    message="同一主键存在字段冲突，不能静默覆盖。",
                    suggestion="合并或修正冲突记录后重新导入。",
                    sheet=table.sheet_name,
                    row_number=row_number,
                    target_field=contract.primary_field,
                    raw_value=key,
                )

    if contract.data_type.value != "orders":
        previous_by_group: dict[tuple[str, str], tuple[int, datetime]] = {}
        for row_number, record, _ in candidate_rows:
            group = (
                str(record.get("order_id", "")),
                str(record.get("shipment_id", "")),
            )
            event_time = to_utc(record.get("event_time"))
            previous = previous_by_group.get(group)
            if event_time is not None and previous is not None and event_time < previous[1]:
                collector.add(
                    severity=IssueSeverity.WARNING,
                    code="TIME_ORDER_CONFLICT",
                    message="事件时间早于同一流程中前一导入行。",
                    suggestion="确认源序号、时区和事件排序；系统不会自动改写。",
                    sheet=table.sheet_name,
                    row_number=row_number,
                    target_field="event_time",
                    raw_value=record.get("event_time"),
                )
            if event_time is not None:
                previous_by_group[group] = (row_number, event_time)

    error_rows = {
        issue.row_number
        for issue in collector.issues
        if issue.severity == IssueSeverity.ERROR and issue.row_number is not None
    }
    warning_rows = {
        issue.row_number
        for issue in collector.issues
        if issue.severity == IssueSeverity.WARNING and issue.row_number is not None
    }
    normalized_rows = [
        record
        for row_number, record, _ in candidate_rows
        if row_number not in error_rows
        and row_number not in excluded_exact_rows
        and row_number not in duplicate_conflict_rows
    ]
    status_normalizations = [status for _, _, status in candidate_rows if status is not None]
    status_metadata = [
        StatusMetadataRow(
            row_number=row_number,
            raw_status=status.raw_status,
            normalized_status=status.normalized_status,
            mapping_source=status.mapping_source,
            mapping_confidence=status.mapping_confidence,
        )
        for row_number, _, status in candidate_rows
        if status is not None
    ]
    issue_codes = Counter(issue.code for issue in collector.issues)
    has_global_error = any(
        issue.severity == IssueSeverity.ERROR and issue.row_number is None
        for issue in collector.issues
    )
    can_confirm = (
        bool(normalized_rows)
        and not error_rows
        and not duplicate_conflict_rows
        and not has_global_error
    )
    report = QualityReport(
        total_rows=len(table.rows),
        valid_rows=len(normalized_rows),
        error_rows=len(error_rows | duplicate_conflict_rows),
        warning_rows=len(warning_rows),
        null_counts=dict(sorted(null_counts.items())),
        duplicate_keys=duplicate_keys,
        invalid_times=(
            issue_codes["INVALID_TIME"]
            + issue_codes["TIMEZONE_REQUIRED"]
            + issue_codes["INVALID_TIMEZONE"]
            + issue_codes["AMBIGUOUS_LOCAL_TIME"]
            + issue_codes["NONEXISTENT_LOCAL_TIME"]
        ),
        time_order_conflicts=issue_codes["TIME_ORDER_CONFLICT"],
        negative_quantities=issue_codes["NEGATIVE_OR_INVALID_QUANTITY"],
        unknown_statuses=issue_codes["UNKNOWN_STATUS"],
        long_text_values=issue_codes["LONG_TEXT_VALUE"],
        unparseable_values=(
            issue_codes["UNPARSEABLE_NUMBER"]
            + issue_codes["AMBIGUOUS_NUMBER_FORMAT"]
            + issue_codes["UNPARSEABLE_INTEGER"]
            + issue_codes["FORMULA_CELL_IGNORED"]
            + issue_codes["EXCEL_ERROR_CELL"]
        ),
        exact_duplicate_rows=len(excluded_exact_rows),
        ignored_source_columns=sorted(ignored_sources),
        unresolved_source_columns=sorted(
            source
            for source in table.headers
            if source not in ignored_sources and mapping.get(source) is None
        ),
        sensitive_risks=sensitive_risks,
        status_normalizations=summarize_statuses(status_normalizations),
        issues=collector.issues,
        can_confirm=can_confirm,
    )
    return ValidationArtifacts(
        report=report,
        normalized_rows=normalized_rows,
        status_metadata=status_metadata,
    )
