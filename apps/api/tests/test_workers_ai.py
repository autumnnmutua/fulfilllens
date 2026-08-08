from __future__ import annotations

import json
from email.message import Message
from types import TracebackType
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request

import pytest
from app.core.config import Settings, get_settings
from app.core.errors import AppError
from app.integrations.cloudflare_workers_ai import (
    PROBE_SENTINEL,
    CloudflareWorkersAIClient,
)
from app.schemas.integrations import WorkersAIProbeResponse, WorkersAIUsage
from fastapi.testclient import TestClient
from pydantic import SecretStr


class FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(
        self,
        exception_type: type[BaseException] | None,
        exception: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        del exception_type, exception, traceback

    def read(self, size: int = -1) -> bytes:
        del size
        return json.dumps(self.payload).encode()


def enabled_settings() -> Settings:
    return Settings(
        workers_ai_enabled=True,
        cloudflare_account_id="a" * 32,
        cloudflare_api_token=SecretStr("synthetic-secret"),
    )


def test_client_probe_uses_only_fixed_synthetic_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[Request] = []
    responses = iter(
        [
            FakeResponse(
                {
                    "success": True,
                    "result": {"status": "active"},
                }
            ),
            FakeResponse(
                {
                    "success": True,
                    "result": {
                        "response": PROBE_SENTINEL,
                        "usage": {
                            "prompt_tokens": 5,
                            "completion_tokens": 2,
                            "total_tokens": 7,
                        },
                    },
                }
            ),
        ]
    )

    def fake_urlopen(request: Request, timeout: float) -> FakeResponse:
        assert timeout == 20
        requests.append(request)
        return next(responses)

    monkeypatch.setattr(
        "app.integrations.cloudflare_workers_ai.urlopen",
        fake_urlopen,
    )

    response = CloudflareWorkersAIClient(enabled_settings()).probe()

    assert response.reachable is True
    assert response.sentinel_matched is True
    assert response.usage.total_tokens == 7
    assert len(requests) == 2
    inference_data = requests[1].data
    assert isinstance(inference_data, bytes)
    inference_payload = json.loads(inference_data)
    assert inference_payload["messages"][1]["content"] == (f"Reply with exactly {PROBE_SENTINEL}")
    assert "order" not in json.dumps(inference_payload).lower()
    assert requests[1].get_header("Authorization") == "Bearer synthetic-secret"


def test_client_maps_auth_error_without_exposing_secret(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def unauthorized(request: Request, timeout: float) -> FakeResponse:
        del request, timeout
        raise HTTPError(
            url="https://api.cloudflare.com/",
            code=403,
            msg="Forbidden",
            hdrs=Message(),
            fp=None,
        )

    monkeypatch.setattr(
        "app.integrations.cloudflare_workers_ai.urlopen",
        unauthorized,
    )

    with pytest.raises(AppError) as captured:
        CloudflareWorkersAIClient(enabled_settings()).probe()

    assert captured.value.code == "WORKERS_AI_AUTH_FAILED"
    assert "synthetic-secret" not in captured.value.message


def test_status_is_desensitized_and_disabled_by_default(client: TestClient) -> None:
    response = client.get("/api/integrations/workers-ai/status")

    assert response.status_code == 200
    assert response.json() == {
        "provider": "cloudflare_workers_ai",
        "enabled": False,
        "configured": False,
        "model": "@cf/meta/llama-3.1-8b-instruct-fast",
        "external_data_policy": "仅允许显式合成探针；不会自动发送导入数据或个人信息。",
    }


def test_probe_requires_explicit_external_call_confirmation(
    client: TestClient,
) -> None:
    response = client.post("/api/integrations/workers-ai/probe")

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "EXTERNAL_CALL_CONFIRMATION_REQUIRED"

    configured_call = client.post(
        "/api/integrations/workers-ai/probe",
        headers={"X-FulfillLens-External-Call": "confirm"},
    )
    assert configured_call.status_code == 503
    assert configured_call.json()["error"]["code"] == "WORKERS_AI_NOT_CONFIGURED"


def test_probe_endpoint_returns_only_desensitized_result(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FL_WORKERS_AI_ENABLED", "true")
    monkeypatch.setenv("FL_CLOUDFLARE_ACCOUNT_ID", "b" * 32)
    monkeypatch.setenv("FL_CLOUDFLARE_API_TOKEN", "synthetic-endpoint-secret")
    get_settings.cache_clear()
    monkeypatch.setattr(
        CloudflareWorkersAIClient,
        "probe",
        lambda self: WorkersAIProbeResponse(
            model=self.model,
            token_status="active",
            sentinel_matched=True,
            usage=WorkersAIUsage(total_tokens=7),
            message="Workers AI 连接与固定合成探针均通过。",
        ),
    )

    response = client.post(
        "/api/integrations/workers-ai/probe",
        headers={"X-FulfillLens-External-Call": "confirm"},
        json={"prompt": "该字段不属于接口契约，不能替换固定探针。"},
    )

    assert response.status_code == 200
    serialized = response.text
    assert "synthetic-endpoint-secret" not in serialized
    assert "该字段不属于接口契约" not in serialized
    assert response.json()["sentinel_matched"] is True
