import pytest
from app.core.config import Settings
from pydantic import SecretStr, ValidationError


def test_cors_rejects_wildcard() -> None:
    with pytest.raises(ValidationError, match="不允许使用通配符"):
        Settings(cors_origins=["*"])


def test_cors_rejects_origin_with_path() -> None:
    with pytest.raises(ValidationError, match="无效的 CORS 来源"):
        Settings(cors_origins=["http://localhost:5173/api"])


def test_cors_normalizes_and_deduplicates_origins() -> None:
    settings = Settings(
        cors_origins=[
            "http://localhost:5173",
            "http://localhost:5173/",
        ]
    )

    assert settings.cors_origins == ["http://localhost:5173"]


def test_workers_ai_rejects_partial_or_implicitly_enabled_configuration() -> None:
    with pytest.raises(ValidationError, match="必须同时配置"):
        Settings(cloudflare_account_id="a" * 32)

    with pytest.raises(ValidationError, match="启用 Workers AI"):
        Settings(workers_ai_enabled=True)


def test_workers_ai_rejects_invalid_account_and_model() -> None:
    with pytest.raises(ValidationError, match="32 位十六进制"):
        Settings(
            cloudflare_account_id="not-an-account",
            cloudflare_api_token=SecretStr("synthetic-secret"),
        )

    with pytest.raises(ValidationError, match="@cf/"):
        Settings(workers_ai_model="https://untrusted.example/model")


def test_workers_ai_secret_is_masked_in_settings_repr() -> None:
    settings = Settings(
        cloudflare_account_id="a" * 32,
        cloudflare_api_token=SecretStr("synthetic-secret"),
    )

    assert "synthetic-secret" not in repr(settings)
