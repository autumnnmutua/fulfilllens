from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "data" / "examples"


def test_generated_report_examples_are_complete_safe_and_chinese_readable() -> None:
    markdown = (EXAMPLES / "promotion-surge-report.md").read_text(encoding="utf-8-sig")
    html = (EXAMPLES / "promotion-surge-report.html").read_text(encoding="utf-8")
    csv_bytes = (EXAMPLES / "promotion-surge-anomaly-orders.csv").read_bytes()

    assert "Executive Summary" in markdown
    assert "数据观察事实" in markdown
    assert "情景估算" in markdown
    assert '<html lang="zh-CN">' in html
    assert "促销爆单教学案例" in html
    assert "可能原因（未经因果验证）" in html
    assert "http://" not in html and "https://" not in html
    assert "<script" not in html and "<link" not in html
    assert csv_bytes.startswith(b"\xef\xbb\xbf")
    csv_text = csv_bytes.decode("utf-8-sig")
    assert "异常类型" in csv_text and "指标版本" in csv_text
