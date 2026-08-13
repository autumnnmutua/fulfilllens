from functools import lru_cache
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

API_ROOT = Path(__file__).resolve().parents[2]
PROJECT_ROOT = API_ROOT.parents[1]
DEFAULT_CORS_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]


class Settings(BaseSettings):
    app_name: str = "FulfillLens"
    app_version: str = "1.1.2"
    api_version: str = "v1"
    environment: Literal["development", "test", "production"] = "development"
    host: str = "127.0.0.1"
    port: int = Field(default=8000, ge=1, le=65535)
    cors_origins: list[str] = Field(default_factory=lambda: DEFAULT_CORS_ORIGINS.copy())
    import_root: Path = PROJECT_ROOT / "data" / "local" / "imports"
    analytics_database: Path = PROJECT_ROOT / "data" / "local" / "analytics.duckdb"
    control_database: Path = PROJECT_ROOT / "data" / "local" / "control.sqlite3"
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


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
