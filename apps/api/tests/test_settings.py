import pytest
from app.core.config import Settings
from pydantic import ValidationError


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
