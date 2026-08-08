from __future__ import annotations

import re
import unicodedata
from urllib.parse import quote

from app.imports.security import escape_csv_formula

CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f]")
UNSAFE_FILENAME = re.compile(r"[<>:\"/\\|?*]")
REPEATED_SEPARATOR = re.compile(r"[-_ ]{2,}")
WINDOWS_RESERVED_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{number}" for number in range(1, 10)),
    *(f"LPT{number}" for number in range(1, 10)),
}


def sanitize_export_stem(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value)
    cleaned = UNSAFE_FILENAME.sub("-", CONTROL_CHARACTERS.sub("", normalized))
    cleaned = REPEATED_SEPARATOR.sub("-", cleaned).strip(" .-_")
    cleaned = cleaned[:72].strip(" .-_") or "fulfilllens-report"
    if cleaned.upper() in WINDOWS_RESERVED_NAMES:
        cleaned = f"report-{cleaned}"
    return cleaned


def export_filename(dataset_name: str, suffix: str, *, label: str = "report") -> str:
    safe_dataset = sanitize_export_stem(dataset_name)
    safe_label = sanitize_export_stem(label)
    return f"fulfilllens-{safe_dataset}-{safe_label}.{suffix}"


def content_disposition(file_name: str) -> str:
    suffix = file_name.rsplit(".", maxsplit=1)[-1]
    ascii_fallback = f"fulfilllens-export.{suffix}"
    return f"attachment; filename=\"{ascii_fallback}\"; filename*=UTF-8''{quote(file_name)}"


def mask_identifier(value: str | None) -> str:
    if value is None or not value:
        return ""
    visible = value[-4:] if len(value) >= 4 else value[-1:]
    return f"***{visible}"


def safe_csv_cell(value: object) -> str:
    return escape_csv_formula(value)
