import json
import re
import unittest
from pathlib import Path

from app.core.config import Settings
from app.metrics.models import DEFINITION_VERSION

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
SCHEMA_DIR = ROOT / "data" / "schemas"


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def read_json(path: Path) -> dict:
    return json.loads(read_text(path))


def markdown_section(document: str, start: str, end: str) -> str:
    return document.split(start, maxsplit=1)[1].split(end, maxsplit=1)[0]


def dictionary_rows(section: str) -> dict[str, list[str]]:
    rows = {}
    for line in section.splitlines():
        if not line.startswith("| `"):
            continue
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        rows[cells[0].strip("`")] = cells
    return rows


class ContractConsistencyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.dictionary = read_text(DOCS / "DATA_DICTIONARY.md")
        cls.metrics = read_text(DOCS / "METRICS.md")
        cls.taxonomy = read_text(DOCS / "STATUS_TAXONOMY.md")
        cls.prd = read_text(DOCS / "PRD.md")
        cls.architecture = read_text(DOCS / "ARCHITECTURE.md")
        cls.status_schema = read_json(SCHEMA_DIR / "status_codes.schema.json")
        cls.row_schemas = [
            read_json(SCHEMA_DIR / "order.schema.json"),
            read_json(SCHEMA_DIR / "warehouse_event.schema.json"),
            read_json(SCHEMA_DIR / "tracking_event.schema.json"),
        ]
        cls.dictionary_tables = [
            dictionary_rows(
                markdown_section(
                    cls.dictionary,
                    "## 3. 订单表 `orders`",
                    "## 4. 仓库事件表 `warehouse_events`",
                )
            ),
            dictionary_rows(
                markdown_section(
                    cls.dictionary,
                    "## 4. 仓库事件表 `warehouse_events`",
                    "## 5. 物流轨迹表 `tracking_events`",
                )
            ),
            dictionary_rows(
                markdown_section(
                    cls.dictionary,
                    "## 5. 物流轨迹表 `tracking_events`",
                    "## 6. 表间一致性规则",
                )
            ),
        ]

    def test_schema_fields_are_documented(self) -> None:
        for schema, rows in zip(
            self.row_schemas,
            self.dictionary_tables,
            strict=True,
        ):
            for field in schema["properties"]:
                with self.subTest(schema=schema["title"], field=field):
                    self.assertIn(field, rows)

    def test_required_fields_match_data_dictionary(self) -> None:
        for schema, rows in zip(
            self.row_schemas,
            self.dictionary_tables,
            strict=True,
        ):
            documented_required = {field for field, cells in rows.items() if cells[3] == "是"}
            with self.subTest(schema=schema["title"]):
                self.assertEqual(set(schema["required"]), documented_required)

    def test_documented_string_limits_match_schema(self) -> None:
        for schema, rows in zip(
            self.row_schemas,
            self.dictionary_tables,
            strict=True,
        ):
            for field, cells in rows.items():
                match = re.search(r"1[–-](\d+)\s*字符", cells[6])
                if not match:
                    continue
                with self.subTest(schema=schema["title"], field=field):
                    self.assertEqual(
                        int(match.group(1)),
                        schema["properties"][field]["maxLength"],
                    )

    def test_standard_statuses_are_documented(self) -> None:
        for definition in self.status_schema["$defs"].values():
            for status in definition["enum"]:
                with self.subTest(status=status):
                    self.assertIn(f"`{status}`", self.taxonomy)

    def test_metric_dependencies_exist_in_schemas(self) -> None:
        schema_fields = {field for schema in self.row_schemas for field in schema["properties"]}
        required_metric_fields = {
            "order_id",
            "created_at",
            "promised_delivery_time",
            "actual_delivery_time",
            "ordered_quantity",
            "delivered_quantity",
            "quantity_unit",
            "order_status",
            "event_time",
            "event_code",
        }
        self.assertTrue(required_metric_fields <= schema_fields)
        for field in required_metric_fields:
            with self.subTest(field=field):
                self.assertIn(f"`{field}`", self.metrics)

    def test_shared_status_refs_use_the_central_taxonomy(self) -> None:
        expected_id = self.status_schema["$id"]
        refs = {
            prop["$ref"]
            for schema in self.row_schemas
            for prop in schema["properties"].values()
            if "$ref" in prop
        }
        self.assertEqual(3, len(refs))
        self.assertTrue(all(ref.startswith(expected_id) for ref in refs))

    def test_required_phase_one_sections_exist(self) -> None:
        self.assertRegex(
            self.prd,
            r"(?m)^## (?:\d+\.\s+)?用户流程—系统模块映射表$",
        )
        self.assertRegex(
            self.metrics,
            r"(?m)^## (?:\d+\.\s+)?指标—字段依赖矩阵$",
        )
        self.assertIn("DuckDB", self.architecture)
        self.assertIn("SQLite", self.architecture)
        self.assertIn("本地优先", self.architecture)

    def test_unknown_status_retention_is_documented(self) -> None:
        for document in (self.prd, self.taxonomy, self.dictionary):
            with self.subTest(document=document[:40]):
                self.assertIn("`unmapped`", document)
                self.assertIn("`raw_status`", document)

    def test_adr_index_and_files_cover_decisions(self) -> None:
        index = read_text(DOCS / "adr" / "README.md")
        for number in range(1, 8):
            prefix = f"{number:04d}-"
            matches = list((DOCS / "adr").glob(f"{prefix}*.md"))
            with self.subTest(adr=prefix):
                self.assertEqual(1, len(matches))
                self.assertRegex(index, re.escape(matches[0].name))

    def test_direct_personal_identifiers_are_not_schema_fields(self) -> None:
        prohibited = {
            "customer_name",
            "phone",
            "mobile",
            "email",
            "address",
            "id_card",
            "tracking_number",
        }
        schema_fields = {field for schema in self.row_schemas for field in schema["properties"]}
        self.assertTrue(prohibited.isdisjoint(schema_fields))

    def test_metric_definition_version_is_consistent(self) -> None:
        self.assertIn(f"定义版本：{DEFINITION_VERSION}", self.metrics)
        self.assertIn(DEFINITION_VERSION, read_text(DOCS / "GOLD_METRICS.md"))
        system_route = read_text(ROOT / "apps" / "api" / "app" / "api" / "routes" / "system.py")
        self.assertIn("metrics=DEFINITION_VERSION", system_route)

    def test_repository_contains_no_live_cloudflare_token(self) -> None:
        credential_pattern = re.compile(r"\bcf(?:ut|at|k)_[A-Za-z0-9_-]{20,}\b")
        checked_roots = (
            ROOT / "README.md",
            ROOT / "docs",
            ROOT / "apps" / "api" / "app",
            ROOT / "apps" / "api" / "tests",
            ROOT / "apps" / "web" / "src",
        )
        hits: list[str] = []
        for checked_root in checked_roots:
            paths = [checked_root] if checked_root.is_file() else checked_root.rglob("*")
            for path in paths:
                if not path.is_file() or path.suffix not in {
                    ".md",
                    ".py",
                    ".ts",
                    ".tsx",
                    ".json",
                }:
                    continue
                if credential_pattern.search(read_text(path)):
                    hits.append(str(path.relative_to(ROOT)))
        self.assertEqual([], hits)

    def test_workers_ai_default_model_matches_documentation(self) -> None:
        workers_ai = read_text(DOCS / "WORKERS_AI.md")
        self.assertIn(Settings().workers_ai_model, workers_ai)


if __name__ == "__main__":
    unittest.main()
