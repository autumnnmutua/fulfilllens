from __future__ import annotations

import argparse
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
API_ROOT = PROJECT_ROOT / "apps" / "api"
if str(API_ROOT) not in sys.path:
    sys.path.insert(0, str(API_ROOT))

from app.cases.generator import (  # noqa: E402
    CASE_CONFIGS,
    customized_config,
    generate_case,
    write_case_artifacts,
)
from app.cases.models import CaseId  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="生成 FulfillLens 可复现教学案例")
    parser.add_argument(
        "--case",
        choices=[case_id.value for case_id in CaseId],
        help="只生成指定案例；省略时生成全部内置案例",
    )
    parser.add_argument("--seed", type=int, help="覆盖指定案例的随机种子")
    parser.add_argument("--orders", type=int, help="覆盖指定案例的订单数（至少 30）")
    parser.add_argument("--output", type=Path, default=PROJECT_ROOT / "data" / "cases")
    parser.add_argument("--no-xlsx", action="store_true", help="不生成可选 XLSX")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if (args.seed is not None or args.orders is not None) and args.case is None:
        raise SystemExit("--seed 或 --orders 只能与 --case 一起使用。")
    case_ids = [CaseId(args.case)] if args.case else list(CaseId)
    for case_id in case_ids:
        config = (
            customized_config(case_id, seed=args.seed, order_count=args.orders)
            if args.case
            else CASE_CONFIGS[case_id]
        )
        generated = generate_case(config)
        destination = write_case_artifacts(
            generated,
            args.output.resolve(),
            include_xlsx=not args.no_xlsx,
        )
        print(
            f"{case_id.value}: {len(generated.orders)} orders -> {destination} (seed={config.seed})"
        )


if __name__ == "__main__":
    main()
