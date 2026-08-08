import json
from pathlib import Path
from typing import Any, cast

from app.diagnostics.engine import ALLOWED_TRACKING_TRANSITIONS, CATEGORY_LABELS
from app.diagnostics.models import DiagnosticRuleSet

ROOT = Path(__file__).resolve().parents[1]


def load_json(path: Path) -> dict[str, Any]:
    return cast(dict[str, Any], json.loads(path.read_text(encoding="utf-8")))


def test_diagnostic_rule_config_is_unique_bounded_and_documented() -> None:
    payload = (ROOT / "data" / "rules" / "diagnostic_rules.v1.json").read_text(encoding="utf-8")
    rule_set = DiagnosticRuleSet.model_validate_json(payload)
    documentation = (ROOT / "docs" / "DIAGNOSTICS.md").read_text(encoding="utf-8")

    assert rule_set.rule_set_version == "diagnostics-v1.0.0"
    assert len(rule_set.rules) == 8
    assert len({rule.rule_id for rule in rule_set.rules}) == len(rule_set.rules)
    assert {rule.category for rule in rule_set.rules} == set(CATEGORY_LABELS)
    for rule in rule_set.rules:
        assert rule.rule_id in documentation
        assert rule.parameters
        for parameter in rule.parameters.values():
            assert parameter.minimum <= parameter.value <= parameter.maximum


def test_tracking_transition_rules_only_use_taxonomy_codes() -> None:
    taxonomy = load_json(ROOT / "data" / "schemas" / "status_codes.schema.json")
    codes = set(taxonomy["$defs"]["trackingEventCode"]["enum"])

    assert all(start in codes and end in codes for start, end in ALLOWED_TRACKING_TRANSITIONS)


def test_cloudflare_document_keeps_ai_out_of_deterministic_diagnostics() -> None:
    cloudflare = (ROOT / "docs" / "CLOUDFLARE_DEPLOYMENT.md").read_text(encoding="utf-8")
    architecture = (ROOT / "docs" / "ARCHITECTURE.md").read_text(encoding="utf-8")

    assert "AI binding" in cloudflare
    assert "不进入指标公式、诊断规则" in cloudflare
    assert "ADR 0008" in architecture
