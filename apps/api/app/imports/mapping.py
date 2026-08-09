from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher

from app.imports.contracts import FIELD_ALIASES, FIELD_LABELS, Contract, get_contract
from app.schemas.imports import DataType, DataTypeCandidate, FieldCandidate, FieldSuggestion

NON_WORD = re.compile(r"[\W_]+", re.UNICODE)


def normalize_field_name(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold().strip()
    return NON_WORD.sub("", normalized)


@dataclass(frozen=True)
class ScoredField:
    field: str
    confidence: float
    method: str


def score_source_column(source_column: str, contract: Contract) -> list[ScoredField]:
    source_normalized = normalize_field_name(source_column)
    scores: list[ScoredField] = []

    for definition in contract.fields:
        field = definition.field
        if source_column == field:
            scores.append(ScoredField(field=field, confidence=1.0, method="英文精确匹配"))
            continue

        field_normalized = normalize_field_name(field)
        if source_normalized == field_normalized:
            scores.append(ScoredField(field=field, confidence=0.98, method="规范化字段名"))
            continue

        aliases = (FIELD_LABELS[field], *FIELD_ALIASES.get(field, ()))
        normalized_aliases = [normalize_field_name(alias) for alias in aliases]
        if source_normalized in normalized_aliases:
            scores.append(ScoredField(field=field, confidence=0.95, method="业务别名精确匹配"))
            continue

        similarity = max(
            (
                SequenceMatcher(None, source_normalized, candidate).ratio()
                for candidate in (field_normalized, *normalized_aliases)
                if candidate
            ),
            default=0.0,
        )
        scores.append(
            ScoredField(
                field=field,
                confidence=round(similarity * 0.88, 4),
                method="字段名相似度",
            )
        )

    return sorted(scores, key=lambda item: (-item.confidence, item.field))


def suggest_mappings(source_columns: list[str], contract: Contract) -> list[FieldSuggestion]:
    suggestions: list[FieldSuggestion] = []
    tentative: list[tuple[int, ScoredField, float]] = []

    for index, source_column in enumerate(source_columns):
        scores = score_source_column(source_column, contract)
        top = scores[0]
        second_confidence = scores[1].confidence if len(scores) > 1 else 0.0
        candidates = [
            FieldCandidate(
                field=item.field,
                label=FIELD_LABELS[item.field],
                confidence=item.confidence,
                method=item.method,
            )
            for item in scores[:3]
            if item.confidence >= 0.35
        ]
        suggestion = FieldSuggestion(
            source_column=source_column,
            suggested_field=None,
            confidence=top.confidence,
            method=top.method,
            candidates=candidates,
        )
        suggestions.append(suggestion)
        if top.confidence >= 0.86 and (
            top.method != "字段名相似度" or top.confidence - second_confidence >= 0.08
        ):
            tentative.append((index, top, second_confidence))

    winners: dict[str, tuple[int, ScoredField]] = {}
    for index, top, _ in tentative:
        current = winners.get(top.field)
        if current is None or top.confidence > current[1].confidence:
            winners[top.field] = (index, top)

    for index, top in winners.values():
        suggestions[index].suggested_field = top.field

    return suggestions


DATA_TYPE_LABELS: dict[DataType, str] = {
    DataType.ORDERS: "订单表",
    DataType.WAREHOUSE_EVENTS: "仓库事件表",
    DataType.TRACKING_EVENTS: "物流轨迹表",
}


def detect_data_types(source_columns: list[str]) -> list[DataTypeCandidate]:
    candidates: list[DataTypeCandidate] = []
    for data_type in DataType:
        contract = get_contract(data_type)
        suggestions = suggest_mappings(source_columns, contract)
        matched = {
            suggestion.suggested_field
            for suggestion in suggestions
            if suggestion.suggested_field is not None
        }
        required = {field.field for field in contract.fields if field.required}
        raw_status = contract.raw_status_field
        normalized_status = contract.normalized_status_field
        status_matched = raw_status in matched or normalized_status in matched
        required.discard(raw_status)
        required.discard(normalized_status)
        required_groups = len(required) + 1
        matched_required = len(required & matched) + int(status_matched)
        required_coverage = matched_required / required_groups
        breadth = min(1.0, len(matched) / max(required_groups, 1))
        confidence = round(required_coverage * 0.8 + breadth * 0.2, 4)
        missing = sorted(required - matched)
        if not status_matched:
            missing.append(raw_status)
        candidates.append(
            DataTypeCandidate(
                data_type=data_type,
                display_name=DATA_TYPE_LABELS[data_type],
                confidence=confidence,
                matched_fields=sorted(matched),
                missing_required_fields=missing,
            )
        )
    return sorted(candidates, key=lambda item: (-item.confidence, item.data_type.value))


def validate_mapping(
    mapping: dict[str, str | None],
    source_columns: list[str],
    contract: Contract,
) -> list[str]:
    errors: list[str] = []
    source_set = set(source_columns)
    unknown_sources = sorted(set(mapping) - source_set)
    if unknown_sources:
        errors.append(f"映射包含未知源列：{', '.join(unknown_sources)}")

    target_fields = [target for target in mapping.values() if target is not None]
    allowed_targets = {field.field for field in contract.fields}
    unknown_targets = sorted(set(target_fields) - allowed_targets)
    if unknown_targets:
        errors.append(f"映射包含未知目标字段：{', '.join(unknown_targets)}")

    duplicates = sorted(target for target in set(target_fields) if target_fields.count(target) > 1)
    if duplicates:
        errors.append(f"目标字段不能重复映射：{', '.join(duplicates)}")

    mapped_targets = set(target_fields)
    required = {field.field for field in contract.fields if field.required}
    raw_status, normalized_status = (
        contract.raw_status_field,
        contract.normalized_status_field,
    )
    if raw_status in mapped_targets or normalized_status in mapped_targets:
        required.discard(raw_status)
        required.discard(normalized_status)
    missing = sorted(required - mapped_targets)
    if missing:
        errors.append(f"缺少必填目标字段：{', '.join(missing)}")
    return errors
