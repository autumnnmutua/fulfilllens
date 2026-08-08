from __future__ import annotations

import re
import unicodedata
from pathlib import Path, PurePosixPath
from zipfile import BadZipFile, ZipFile

from app.core.errors import AppError

ALLOWED_EXTENSIONS = {".csv", ".xlsx"}
CSV_MIME_TYPES = {
    "text/csv",
    "application/csv",
    "text/plain",
    "application/vnd.ms-excel",
    "application/octet-stream",
}
XLSX_MIME_TYPES = {
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/zip",
    "application/octet-stream",
}
FORMULA_PREFIXES = ("=", "+", "-", "@")
CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f]")
WINDOWS_RESERVED = re.compile(r'[<>:"/\\|?*]')


def sanitize_filename(filename: str | None) -> tuple[str, str]:
    if not filename:
        raise AppError(
            code="MISSING_FILENAME",
            message="上传文件缺少文件名。",
            status_code=400,
        )

    normalized = unicodedata.normalize("NFKC", filename)
    basename = normalized.replace("\\", "/").rsplit("/", maxsplit=1)[-1]
    cleaned = WINDOWS_RESERVED.sub("_", CONTROL_CHARACTERS.sub("", basename)).strip(" .")
    if not cleaned:
        cleaned = "upload"

    suffix = Path(cleaned).suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise AppError(
            code="UNSUPPORTED_FILE_EXTENSION",
            message="仅支持 .csv 和 .xlsx 文件。",
            status_code=415,
        )

    stem = Path(cleaned).stem[:100].strip(" .") or "upload"
    return f"{stem}{suffix}", suffix


def validate_mime_type(extension: str, content_type: str | None) -> None:
    normalized = (content_type or "application/octet-stream").split(";", maxsplit=1)[0].lower()
    allowed = CSV_MIME_TYPES if extension == ".csv" else XLSX_MIME_TYPES
    if normalized not in allowed:
        raise AppError(
            code="UNSUPPORTED_MIME_TYPE",
            message=f"文件 MIME 类型 {normalized} 与扩展名不匹配。",
            status_code=415,
        )


def validate_file_signature(path: Path, extension: str) -> None:
    prefix = path.read_bytes()[:8]
    if not prefix:
        raise AppError(
            code="EMPTY_FILE",
            message="上传文件为空。",
            status_code=400,
        )
    if extension == ".xlsx" and not prefix.startswith(b"PK"):
        raise AppError(
            code="INVALID_XLSX_SIGNATURE",
            message="文件扩展名为 .xlsx，但内容不是有效的 Office Open XML 包。",
            status_code=415,
        )
    if extension == ".csv" and (
        prefix.startswith(b"PK") or prefix.startswith(bytes.fromhex("D0CF11E0"))
    ):
        raise AppError(
            code="INVALID_CSV_SIGNATURE",
            message="CSV 文件内容与扩展名不一致。",
            status_code=415,
        )


def inspect_xlsx_archive(
    path: Path,
    *,
    max_entries: int,
    max_uncompressed_bytes: int,
) -> None:
    try:
        with ZipFile(path) as archive:
            entries = archive.infolist()
            if len(entries) > max_entries:
                raise AppError(
                    code="XLSX_TOO_MANY_ENTRIES",
                    message="XLSX 内部文件数量超过安全上限。",
                    status_code=413,
                )

            names = {entry.filename for entry in entries}
            if "[Content_Types].xml" not in names or "xl/workbook.xml" not in names:
                raise AppError(
                    code="INVALID_XLSX_PACKAGE",
                    message="XLSX 缺少必要的工作簿结构。",
                    status_code=415,
                )

            total_uncompressed = 0
            for entry in entries:
                posix_path = PurePosixPath(entry.filename)
                if posix_path.is_absolute() or ".." in posix_path.parts:
                    raise AppError(
                        code="XLSX_PATH_TRAVERSAL",
                        message="XLSX 包含不安全的内部路径。",
                        status_code=400,
                    )
                if entry.flag_bits & 0x1:
                    raise AppError(
                        code="ENCRYPTED_XLSX_NOT_SUPPORTED",
                        message="不支持加密或受密码保护的 XLSX。",
                        status_code=400,
                    )

                lowered = entry.filename.casefold()
                forbidden = (
                    "vbaproject.bin",
                    "xl/externallinks/",
                    "xl/embeddings/",
                    "xl/activex/",
                    "customui/",
                )
                if lowered.endswith(".bin") or any(item in lowered for item in forbidden):
                    raise AppError(
                        code="ACTIVE_XLSX_CONTENT",
                        message="XLSX 包含宏、外链或嵌入对象，已拒绝读取。",
                        status_code=400,
                    )

                total_uncompressed += entry.file_size
                if total_uncompressed > max_uncompressed_bytes:
                    raise AppError(
                        code="XLSX_UNCOMPRESSED_TOO_LARGE",
                        message="XLSX 解压后大小超过安全上限。",
                        status_code=413,
                    )
                if (
                    entry.file_size > 1024 * 1024
                    and entry.file_size / max(entry.compress_size, 1) > 100
                ):
                    raise AppError(
                        code="XLSX_SUSPICIOUS_COMPRESSION",
                        message="XLSX 包含异常压缩比内容，可能是解压炸弹。",
                        status_code=413,
                    )
    except BadZipFile as error:
        raise AppError(
            code="INVALID_XLSX_PACKAGE",
            message="XLSX 压缩包损坏或格式无效。",
            status_code=415,
        ) from error


def escape_csv_formula(value: object) -> str:
    text = "" if value is None else str(value)
    if text.lstrip().startswith(FORMULA_PREFIXES):
        return f"'{text}"
    return text


def mask_sensitive_value(value: object) -> str | None:
    if value is None or str(value) == "":
        return None
    return "••••（敏感原值已隐藏）"
