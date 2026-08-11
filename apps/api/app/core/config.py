from functools import lru_cache
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

API_ROOT = Path(__file__).resolve().parents[2]
PROJECT_ROOT = API_ROOT.parents[1]
DEFAULT_CORS_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]


class Settings(BaseSettings):
    app_name: str = "FulfillLens"
    app_version: str = "1.1.1"
    api_version: str = "v1"
    environment: Literal["development", "test", "production"] = "development"
    host: str = "127.0.0.1"
    port: int = Field(default=8000, ge=1, le=65535)
    cors_origins: list[str] = Field(default_factory=lambda: DEFAULT_CORS_ORIGINS.copy())
    import_root: Path = PROJECT_ROOT / "data" / "local" / "imports"
    analytics_database: Path = PROJECT_ROOT / "data" / "local" / "analytics.duckdb"
    control_database: Path = PROJECT_ROOT / "data" / "local" / "control.sqlite3"
    workers_ai_enabled: bool = False
    cloudflare_account_id: str | None = None
    cloudflare_api_token: SecretStr | None = None
    workers_ai_model: str = "@cf/meta/llama-3.1-8b-instruct-fast"
    workers_ai_timeout_seconds: float = Field(default=20.0, ge=1.0, le=60.0)
    max_upload_bytes: int = Field(default=10 * 1024 * 1024, ge=1024)
    max_xlsx_uncompressed_bytes: int = Field(default=50 * 1024 * 1024, ge=1024)
    max_xlsx_entries: int = Field(default=512, ge=16, le=10_000)
    max_import_rows: int = Field(default=50_000, ge=1)
    max_import_columns: int = Field(default=200, ge=1, le=16_384)
    max_cell_chars: int = Field(default=4096, ge=128)
    import_task_ttl_hours: int = Field(default=24, ge=1, le=24 * 30)
    max_export_bytes: int = Field(default=50 * 1024 * 1024, ge=1024, le=512 * 1024 * 1024)

    model_config = SettingsConfigDict(
        env_file=API_ROOT / ".env",
        env_prefix="FL_",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    @field_validator("cors_origins")
    @classmethod
    def validate_cors_origins(cls, origins: list[str]) -> list[str]:
        if not origins:
            raise ValueError("至少需要配置一个明确的 CORS 来源")

        normalized: list[str] = []
        for origin in origins:
            if origin == "*":
                raise ValueError("CORS 来源不允许使用通配符 *")

            parsed = urlsplit(origin)
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.netloc
                or parsed.path not in {"", "/"}
                or parsed.query
                or parsed.fragment
            ):
                raise ValueError(f"无效的 CORS 来源：{origin}")

            normalized.append(f"{parsed.scheme}://{parsed.netloc}")

        return list(dict.fromkeys(normalized))

    @field_validator("import_root", "analytics_database", "control_database")
    @classmethod
    def resolve_local_path(cls, value: Path) -> Path:
        path = value if value.is_absolute() else PROJECT_ROOT / value
        return path.resolve()

    @field_validator("cloudflare_account_id", mode="before")
    @classmethod
    def normalize_optional_account_id(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip() or None
        return value

    @field_validator("cloudflare_api_token", mode="before")
    @classmethod
    def normalize_optional_api_token(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip() or None
        return value

    @field_validator("cloudflare_account_id")
    @classmethod
    def validate_cloudflare_account_id(cls, value: str | None) -> str | None:
        if value is not None and (
            len(value) != 32
            or any(character not in "0123456789abcdefABCDEF" for character in value)
        ):
            raise ValueError("Cloudflare Account ID 必须是 32 位十六进制字符串")
        return value.lower() if value is not None else None

    @field_validator("workers_ai_model")
    @classmethod
    def validate_workers_ai_model(cls, value: str) -> str:
        allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@/._-")
        if not value.startswith("@cf/") or any(character not in allowed for character in value):
            raise ValueError("Workers AI 模型必须是安全的 @cf/ 模型标识")
        return value

    @model_validator(mode="after")
    def validate_workers_ai_configuration(self) -> "Settings":
        has_account = self.cloudflare_account_id is not None
        has_token = self.cloudflare_api_token is not None
        if has_account != has_token:
            raise ValueError("Cloudflare Account ID 与 API Token 必须同时配置")
        if self.workers_ai_enabled and not has_account:
            raise ValueError("启用 Workers AI 前必须配置 Account ID 与 API Token")
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
