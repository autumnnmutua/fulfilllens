from __future__ import annotations

from functools import lru_cache

from app.core.config import PROJECT_ROOT
from app.core.errors import AppError
from app.diagnostics.models import DiagnosticRule, DiagnosticRuleSet, RuleOverride

RULE_CONFIG_PATH = PROJECT_ROOT / "data" / "rules" / "diagnostic_rules.v1.json"


@lru_cache(maxsize=1)
def load_default_rule_set() -> DiagnosticRuleSet:
    try:
        return DiagnosticRuleSet.model_validate_json(RULE_CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise RuntimeError("诊断规则配置无法读取或不符合契约") from error


def resolve_rule_set(overrides: dict[str, RuleOverride]) -> DiagnosticRuleSet:
    resolved = load_default_rule_set().model_copy(deep=True)
    rules_by_id = {rule.rule_id: rule for rule in resolved.rules}
    unknown_rule_ids = sorted(set(overrides) - set(rules_by_id))
    if unknown_rule_ids:
        raise AppError(
            code="UNKNOWN_DIAGNOSTIC_RULE",
            message=f"不存在的诊断规则：{', '.join(unknown_rule_ids)}。",
            status_code=422,
        )

    for rule_id, override in overrides.items():
        rule = rules_by_id[rule_id]
        if override.enabled is not None:
            rule.enabled = override.enabled
        unknown_parameters = sorted(set(override.parameters) - set(rule.parameters))
        if unknown_parameters:
            raise AppError(
                code="UNKNOWN_DIAGNOSTIC_PARAMETER",
                message=(f"规则 {rule_id} 不存在参数：{', '.join(unknown_parameters)}。"),
                status_code=422,
            )
        for name, value in override.parameters.items():
            parameter = rule.parameters[name]
            if not parameter.minimum <= value <= parameter.maximum:
                raise AppError(
                    code="DIAGNOSTIC_PARAMETER_OUT_OF_RANGE",
                    message=(
                        f"规则 {rule_id} 的 {name} 必须在 "
                        f"{parameter.minimum} 到 {parameter.maximum} 之间。"
                    ),
                    status_code=422,
                )
            parameter.value = value
    return resolved


def enabled_rules(rule_set: DiagnosticRuleSet) -> dict[str, DiagnosticRule]:
    return {rule.rule_id: rule for rule in rule_set.rules if rule.enabled}
