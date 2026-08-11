from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
REQUIRED_FILES = (
    "README.md",
    "README_EN.md",
    "LICENSE",
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
    "SECURITY.md",
    "CHANGELOG.md",
    "CITATION.cff",
    "docs/README.md",
    "docs/FAQ.md",
    "docs/TROUBLESHOOTING.md",
    "docs/DEPENDENCY_LICENSES.md",
    "docs/SCREENSHOTS.md",
    "docs/releases/v1.0.0.md",
    "docs/releases/v1.1.0.md",
    "docs/releases/v1.1.1.md",
    ".github/ISSUE_TEMPLATE/bug.yml",
    ".github/ISSUE_TEMPLATE/feature.yml",
    ".github/ISSUE_TEMPLATE/data-mapping.yml",
    ".github/pull_request_template.md",
)
REQUIRED_README_CN = (
    "## 为什么使用 FulfillLens",
    "## 截图与演示",
    "## 核心能力",
    "## 适用与不适用场景",
    "## 10 分钟快速体验",
    "## 导入格式与数据规则",
    "## 技术架构",
    "## 项目状态与已知限制",
    "## 路线图",
    "## 隐私、安全与免责声明",
    "## 贡献",
    "## 许可证",
)
REQUIRED_README_EN = (
    "## Why FulfillLens",
    "## Screenshots and demo",
    "## Core capabilities",
    "## Suitable and unsuitable use cases",
    "## 10-minute quick experience",
    "## Import formats and data rules",
    "## Technical architecture",
    "## Project status and known limitations",
    "## Roadmap",
    "## Privacy, security, and disclaimer",
    "## Contributing",
    "## License",
)
REQUIRED_SCRIPTS = {
    "dev",
    "build",
    "lint",
    "format",
    "format:check",
    "typecheck",
    "test",
    "smoke",
    "audit",
    "docs:check",
    "licenses:check",
    "release:check",
}
MARKDOWN_LINK = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
NPM_RUN_COMMAND = re.compile(r"\bnpm(?:\.cmd)? run ([A-Za-z0-9:_-]+)")
PYTHON_SCRIPT_COMMAND = re.compile(r"\bpython scripts/([A-Za-z0-9_.-]+\.py)")
SECRET_PATTERNS = {
    "Cloudflare API Token": re.compile(r"cfut_[A-Za-z0-9_-]{20,}"),
    "private key": re.compile(r"BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY"),
    "assigned long secret": re.compile(
        r"(?i)(?:api[_-]?key|secret|token)\s*[:=]\s*[\"']?[A-Za-z0-9_-]{24,}"
    ),
}
PERSONAL_PATH = re.compile(r"(?i)(?:[A-Z]:\\Users\\|D:\\xwechat_files\\|/Users/|/home/[^/]+/)")
CN_PHONE = re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")
CN_ID = re.compile(r"(?<!\d)\d{17}[0-9Xx](?!\d)")
SYNTHETIC_PII_ALLOWLIST = {Path("apps/api/tests/test_import_validation.py")}
SCANNER_SOURCE = Path("scripts/check_release_docs.py")
TEXT_SUFFIXES = {
    ".cff",
    ".cjs",
    ".csv",
    ".html",
    ".js",
    ".json",
    ".md",
    ".py",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".yaml",
    ".yml",
}
DISALLOWED_ARTIFACT_SUFFIXES = {
    ".bak",
    ".db",
    ".log",
    ".sqlite",
    ".sqlite3",
    ".tmp",
}


def candidate_files() -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    paths = [Path(item.decode("utf-8")) for item in result.stdout.split(b"\0") if item]
    return sorted(path for path in paths if (ROOT / path).is_file())


def read_text(path: Path) -> str | None:
    if path.suffix.lower() not in TEXT_SUFFIXES and path.name != "LICENSE":
        return None
    try:
        return (ROOT / path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def local_link_errors(markdown_files: list[Path]) -> list[str]:
    errors: list[str] = []
    for relative in markdown_files:
        text = read_text(relative)
        if text is None:
            continue
        for raw_destination in MARKDOWN_LINK.findall(text):
            destination = raw_destination.strip()
            if destination.startswith("<") and ">" in destination:
                destination = destination[1 : destination.index(">")]
            else:
                destination = destination.split(maxsplit=1)[0]
            if not destination or destination.startswith(("#", "http://", "https://", "mailto:")):
                continue
            path_text = unquote(destination.split("#", 1)[0])
            if not path_text:
                continue
            if Path(path_text).is_absolute():
                errors.append(f"{relative}: local Markdown link must be relative: {destination}")
                continue
            target = (ROOT / relative.parent / path_text).resolve()
            try:
                target.relative_to(ROOT)
            except ValueError:
                errors.append(f"{relative}: link leaves repository: {destination}")
                continue
            if not target.exists():
                errors.append(f"{relative}: missing local link target: {destination}")
    return errors


def main() -> int:
    errors: list[str] = []
    files = candidate_files()

    for required in REQUIRED_FILES:
        if not (ROOT / required).is_file():
            errors.append(f"missing required release file: {required}")

    readme_cn = (ROOT / "README.md").read_text(encoding="utf-8")
    readme_en = (ROOT / "README_EN.md").read_text(encoding="utf-8")
    for heading in REQUIRED_README_CN:
        if heading not in readme_cn:
            errors.append(f"README.md missing section: {heading}")
    for heading in REQUIRED_README_EN:
        if heading not in readme_en:
            errors.append(f"README_EN.md missing section: {heading}")
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    for required_text in (
        package["version"],
        "127.0.0.1:5173",
        "127.0.0.1:8000",
    ):
        if required_text not in readme_cn or required_text not in readme_en:
            errors.append(f"bilingual README mismatch or missing value: {required_text}")

    scripts = package.get("scripts", {})
    missing_scripts = sorted(REQUIRED_SCRIPTS - set(scripts))
    if missing_scripts:
        errors.append(f"package.json missing scripts: {', '.join(missing_scripts)}")
    if package.get("license") != "MIT":
        errors.append("root package.json must declare MIT")

    markdown = [path for path in files if path.suffix.lower() == ".md"]
    errors.extend(local_link_errors(markdown))
    for relative in markdown:
        text = read_text(relative) or ""
        for command in sorted(set(NPM_RUN_COMMAND.findall(text))):
            if command not in scripts:
                errors.append(f"{relative}: unknown package script in docs: npm run {command}")
        for script_name in sorted(set(PYTHON_SCRIPT_COMMAND.findall(text))):
            if not (ROOT / "scripts" / script_name).is_file():
                errors.append(f"{relative}: missing documented Python script: {script_name}")

    for relative in files:
        absolute = ROOT / relative
        if absolute.stat().st_size > 10 * 1024 * 1024:
            errors.append(f"unignored file exceeds 10 MiB: {relative}")
        if relative.suffix.lower() in DISALLOWED_ARTIFACT_SUFFIXES:
            errors.append(f"unignored local artifact: {relative}")
        is_private_env = relative.name == ".env" or (
            relative.name.startswith(".env.") and relative.name != ".env.example"
        )
        if is_private_env:
            errors.append(f"unignored environment file: {relative}")

        text = read_text(relative)
        if text is None:
            continue
        for label, pattern in SECRET_PATTERNS.items():
            if pattern.search(text):
                errors.append(f"{relative}: possible {label}")
        if relative != SCANNER_SOURCE and PERSONAL_PATH.search(text):
            errors.append(f"{relative}: personal absolute path")
        if relative == SCANNER_SOURCE:
            continue
        if relative in SYNTHETIC_PII_ALLOWLIST:
            allowed_phones = {"13800138000", "13900139000"}
            discovered_phones = set(CN_PHONE.findall(text))
            if discovered_phones - allowed_phones or "synthetic PII-like fixtures" not in text:
                errors.append(f"{relative}: synthetic PII allowlist no longer matches fixture")
        else:
            if CN_PHONE.search(text):
                errors.append(f"{relative}: possible Chinese mobile number")
            if CN_ID.search(text):
                errors.append(f"{relative}: possible Chinese identity number")

    license_text = (ROOT / "LICENSE").read_text(encoding="utf-8")
    if "MIT License" not in license_text or "FulfillLens contributors" not in license_text:
        errors.append("LICENSE is not the expected MIT text")

    if errors:
        print("Release documentation check failed:")
        for error in errors:
            print(f"- {error}")
        return 1

    print(
        "Release documentation check passed: "
        f"{len(files)} candidate files, {len(markdown)} Markdown files, "
        "bilingual sections, local links, release assets, privacy and artifact rules."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
