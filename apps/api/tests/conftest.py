from collections.abc import Generator
from pathlib import Path

import pytest
from app.core.config import get_settings
from app.main import create_app
from fastapi.testclient import TestClient


@pytest.fixture
def client(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> Generator[TestClient]:
    monkeypatch.setenv("FL_ENVIRONMENT", "test")
    monkeypatch.setenv("FL_IMPORT_ROOT", str(tmp_path / "imports"))
    monkeypatch.setenv("FL_ANALYTICS_DATABASE", str(tmp_path / "analytics.duckdb"))
    monkeypatch.setenv("FL_CONTROL_DATABASE", str(tmp_path / "control.sqlite3"))
    get_settings.cache_clear()
    with TestClient(create_app()) as test_client:
        yield test_client
    get_settings.cache_clear()
