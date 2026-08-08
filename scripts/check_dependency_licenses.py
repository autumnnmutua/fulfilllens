from __future__ import annotations

import json
import re
import sys
from collections import Counter
from importlib.metadata import distributions
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
BLOCKED = re.compile(
    r"(?i)(?:AGPL|LGPL|GPL-|GNU (?:Affero |Lesser )?General Public|SSPL|BUSL|Commons Clause)"
)
REVIEW = re.compile(r"(?i)(?:MPL|Mozilla Public|CC-BY|Creative Commons)")


def normalized_npm_license(value: Any) -> str:
    if isinstance(value, str):
        return value.strip() or "UNKNOWN"
    if isinstance(value, list):
        parts = [normalized_npm_license(item) for item in value]
        return " OR ".join(part for part in parts if part != "UNKNOWN") or "UNKNOWN"
    if isinstance(value, dict):
        return normalized_npm_license(value.get("type"))
    return "UNKNOWN"


def npm_inventory() -> dict[tuple[str, str], str]:
    inventory: dict[tuple[str, str], str] = {}
    for package_path in (ROOT / "node_modules").rglob("package.json"):
        if ".bin" in package_path.parts:
            continue
        try:
            package = json.loads(package_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        name = package.get("name")
        version = package.get("version")
        if isinstance(name, str) and isinstance(version, str):
            license_value = package.get("license", package.get("licenses"))
            inventory[(name, version)] = normalized_npm_license(license_value)
    return inventory


def direct_npm_dependencies() -> set[str]:
    result: set[str] = set()
    for package_path in (ROOT / "package.json", ROOT / "apps/web/package.json"):
        package = json.loads(package_path.read_text(encoding="utf-8"))
        for group in ("dependencies", "devDependencies"):
            result.update(package.get(group, {}))
    return result


def python_license(distribution: Any) -> str:
    expression = distribution.metadata.get("License-Expression")
    if expression:
        return str(expression).strip()
    classifiers = distribution.metadata.get_all("Classifier") or []
    licenses = sorted(
        {
            classifier.split(" :: ")[-1]
            for classifier in classifiers
            if classifier.startswith("License ::")
        }
    )
    if licenses:
        return "; ".join(licenses)
    raw = str(distribution.metadata.get("License") or "UNKNOWN")
    return raw.splitlines()[0].strip()[:160] or "UNKNOWN"


def python_inventory() -> dict[str, tuple[str, str]]:
    return {
        str(distribution.metadata.get("Name")).lower().replace("_", "-"): (
            distribution.version,
            python_license(distribution),
        )
        for distribution in distributions()
        if distribution.metadata.get("Name")
    }


def requirement_names(path: Path, seen: set[Path] | None = None) -> set[str]:
    resolved = path.resolve()
    visited = seen if seen is not None else set()
    if resolved in visited:
        return set()
    visited.add(resolved)
    names: set[str] = set()
    for raw_line in resolved.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("-r "):
            names.update(requirement_names(resolved.parent / line[3:].strip(), visited))
            continue
        name = re.split(r"[<>=!~\[]", line, maxsplit=1)[0].strip()
        names.add(name.lower().replace("_", "-"))
    return names


def main() -> int:
    errors: list[str] = []
    npm_packages = npm_inventory()
    npm_direct = direct_npm_dependencies()
    npm_by_name: dict[str, list[tuple[str, str]]] = {}
    for (name, version), license_name in npm_packages.items():
        npm_by_name.setdefault(name, []).append((version, license_name))

    for name in sorted(npm_direct):
        matches = npm_by_name.get(name, [])
        if not matches:
            errors.append(f"npm direct dependency is not installed: {name}")
        elif all(license_name == "UNKNOWN" for _, license_name in matches):
            errors.append(f"npm direct dependency has unknown license: {name}")
    for (name, version), license_name in sorted(npm_packages.items()):
        if BLOCKED.search(license_name):
            errors.append(f"blocked npm license: {name}@{version} ({license_name})")

    python_packages = python_inventory()
    python_direct = requirement_names(ROOT / "apps/api/requirements-dev.txt")
    for name in sorted(python_direct):
        metadata = python_packages.get(name)
        if metadata is None:
            errors.append(f"Python direct dependency is not installed: {name}")
        elif metadata[1] == "UNKNOWN":
            errors.append(f"Python direct dependency has unknown license: {name}")
    for name, (version, license_name) in sorted(python_packages.items()):
        if BLOCKED.search(license_name):
            errors.append(f"blocked Python license: {name}=={version} ({license_name})")

    npm_review = [
        f"{name}@{version} ({license_name})"
        for (name, version), license_name in sorted(npm_packages.items())
        if REVIEW.search(license_name)
    ]
    python_review = [
        f"{name}=={version} ({license_name})"
        for name, (version, license_name) in sorted(python_packages.items())
        if REVIEW.search(license_name)
    ]

    if errors:
        print("Dependency license check failed:")
        for error in errors:
            print(f"- {error}")
        return 1

    npm_counts = Counter(npm_packages.values())
    python_counts = Counter(license_name for _, license_name in python_packages.values())
    print(
        f"Dependency license check passed: {len(npm_packages)} npm packages "
        f"({len(npm_counts)} license labels), {len(python_packages)} Python distributions "
        f"({len(python_counts)} license labels), no blocked licenses or unknown direct licenses."
    )
    print("Review/notice npm packages: " + (", ".join(npm_review) or "none"))
    print("Review/notice Python packages: " + (", ".join(python_review) or "none"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
