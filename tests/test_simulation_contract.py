import json
from pathlib import Path
from typing import Any, cast

ROOT = Path(__file__).resolve().parents[1]


def load_package() -> dict[str, Any]:
    return cast(
        dict[str, Any],
        json.loads((ROOT / "package.json").read_text(encoding="utf-8")),
    )


def test_simulation_document_covers_parameters_versions_and_misuse() -> None:
    documentation = (ROOT / "docs" / "SIMULATION.md").read_text(encoding="utf-8")

    for required in (
        "simulation-v1.0.0",
        "metrics-v1.1.0",
        "仓内节点固定减少",
        "出库至揽收等待减少",
        "承运商目标权重",
        "承诺时效放宽",
        "经验重采样",
        "情景估算",
        "不代表真实预测或保证",
    ):
        assert required in documentation


def test_simulation_architecture_and_adr_keep_core_ai_free() -> None:
    architecture = (ROOT / "docs" / "ARCHITECTURE.md").read_text(encoding="utf-8")
    adr = (ROOT / "docs" / "adr" / "0009-order-level-reproducible-simulation.md").read_text(
        encoding="utf-8"
    )
    engine = (ROOT / "apps" / "api" / "app" / "simulation" / "engine.py").read_text(
        encoding="utf-8"
    )

    assert "apps/api/app/simulation/" in architecture
    assert "/api/simulations" in architecture
    assert "核心模拟不调用外部生成式模型" in adr
    assert "workers_ai" not in engine.lower()


def test_demo_and_readmes_expose_real_simulation_entry() -> None:
    package = load_package()
    root_readme = (ROOT / "README.md").read_text(encoding="utf-8")
    web_readme = (ROOT / "apps" / "web" / "README.md").read_text(encoding="utf-8")

    assert package["scripts"]["demo:simulation"] == "python scripts/demo_simulation.py"
    assert "demo_simulation.py" in root_readme
    assert "访问 `/scenarios`" in web_readme
