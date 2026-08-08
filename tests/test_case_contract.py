import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_all_case_metadata_declares_reproducibility_privacy_and_expected_ranges() -> None:
    case_root = ROOT / "data" / "cases"
    directories = sorted(path for path in case_root.iterdir() if path.is_dir())
    assert [path.name for path in directories] == [
        "carrier_disruption",
        "normal_operations",
        "promotion_surge",
    ]
    for directory in directories:
        metadata = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
        assert metadata["generator_version"] == "case-generator-v1.0.0"
        assert isinstance(metadata["seed"], int)
        assert metadata["timezone"] == "Asia/Shanghai"
        assert metadata["content_fingerprint"]
        assert "完全由程序生成" in metadata["privacy_statement"]
        assert {"ot_rate", "if_rate", "otif_rate"} <= set(metadata["expected_metric_ranges"])
