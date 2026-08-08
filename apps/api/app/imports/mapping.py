from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher

from app.imports.contracts import FIELD_ALIASES, FIELD_LABELS, Contract
from app.schemas.imports import FieldCandidate, FieldSuggestion

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
            scores.append(ScoredField(field=field, confidence=0.95, method="中文别名精确匹配"))
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
