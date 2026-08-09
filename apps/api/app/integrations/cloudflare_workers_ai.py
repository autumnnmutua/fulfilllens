from __future__ import annotations

import json
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from app.core.config import Settings
from app.core.errors import AppError
from app.schemas.integrations import WorkersAIProbeResponse, WorkersAIUsage

VERIFY_URL = "https://api.cloudflare.com/client/v4/user/tokens/verify"
API_BASE_URL = "https://api.cloudflare.com/client/v4"
PROBE_SENTINEL = "FULFILLLENS_WORKERS_AI_OK"
MAX_RESPONSE_BYTES = 1024 * 1024
PROBE_MESSAGES = [
    {
        "role": "system",
        "content": "You are a connectivity probe. Never request or reveal user data.",
    },
    {
        "role": "user",
        "content": f"Reply with exactly {PROBE_SENTINEL}",
    },
]


class CloudflareWorkersAIClient:
    def __init__(self, settings: Settings) -> None:
        if (
            not settings.workers_ai_enabled
            or settings.cloudflare_account_id is None
            or settings.cloudflare_api_token is None
        ):
            raise AppError(
                code="WORKERS_AI_NOT_CONFIGURED",
                message="Workers AI 未启用或凭据未完整配置。",
                status_code=503,
            )
        self.account_id = settings.cloudflare_account_id
        self.api_token = settings.cloudflare_api_token.get_secret_value()
        self.model = settings.workers_ai_model
        self.timeout = settings.workers_ai_timeout_seconds

    def probe(self) -> WorkersAIProbeResponse:
        verification = self._request_json(VERIFY_URL, method="GET")
        status = self._read_token_status(verification)
        if status is None:
            raise self._invalid_response()
        if status != "active":
            raise AppError(
                code="WORKERS_AI_TOKEN_INACTIVE",
                message="Cloudflare API Token 当前不是 active 状态。",
                status_code=502,
            )

        encoded_model = quote(self.model, safe="@/._-")
        endpoint = f"{API_BASE_URL}/accounts/{self.account_id}/ai/run/{encoded_model}"
        inference = self._request_json(
            endpoint,
            method="POST",
            payload={
                "messages": PROBE_MESSAGES,
                "max_tokens": 32,
                "temperature": 0,
            },
        )
        result = inference.get("result")
        if not inference.get("success") or not isinstance(result, dict):
            raise self._invalid_response()
        response = result.get("response")
        if not isinstance(response, str) or not response.strip():
            raise self._invalid_response()
        usage = result.get("usage")
        usage_payload = usage if isinstance(usage, dict) else {}
        sentinel_matched = response.strip() == PROBE_SENTINEL
        return WorkersAIProbeResponse(
            model=self.model,
            token_status="active",
            sentinel_matched=sentinel_matched,
            usage=WorkersAIUsage(
                prompt_tokens=self._optional_non_negative_int(usage_payload.get("prompt_tokens")),
                completion_tokens=self._optional_non_negative_int(
                    usage_payload.get("completion_tokens")
                ),
                total_tokens=self._optional_non_negative_int(usage_payload.get("total_tokens")),
            ),
            message=(
                "Workers AI 连接与固定合成探针均通过。"
                if sentinel_matched
                else "Workers AI 可访问，但模型未严格返回固定探针文本。"
            ),
        )

    def _request_json(
        self,
        url: str,
        *,
        method: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        body = (
            json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
            if payload is not None
            else None
        )
        request = Request(
            url,
            data=body,
            method=method,
            headers={
                "Authorization": f"Bearer {self.api_token}",
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": "FulfillLens-CN/1.0.0-rc.5 Workers-AI-Probe",
            },
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                raw_response = response.read(MAX_RESPONSE_BYTES + 1)
                if len(raw_response) > MAX_RESPONSE_BYTES:
                    raise self._invalid_response()
                parsed = json.loads(raw_response.decode("utf-8"))
        except HTTPError as error:
            raise self._http_error(error.code) from error
        except (TimeoutError, URLError) as error:
            raise AppError(
                code="WORKERS_AI_UNREACHABLE",
                message="无法连接 Cloudflare Workers AI，请检查网络后重试。",
                status_code=502,
            ) from error
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise self._invalid_response() from error
        if not isinstance(parsed, dict):
            raise self._invalid_response()
        return parsed

    @staticmethod
    def _read_token_status(payload: dict[str, Any]) -> str | None:
        result = payload.get("result")
        if not payload.get("success") or not isinstance(result, dict):
            return None
        status = result.get("status")
        return status if isinstance(status, str) else None

    @staticmethod
    def _optional_non_negative_int(value: object) -> int | None:
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            return None
        return value

    @staticmethod
    def _invalid_response() -> AppError:
        return AppError(
            code="WORKERS_AI_INVALID_RESPONSE",
            message="Cloudflare Workers AI 返回了无法识别的响应。",
            status_code=502,
        )

    @staticmethod
    def _http_error(status_code: int) -> AppError:
        if status_code in {401, 403}:
            return AppError(
                code="WORKERS_AI_AUTH_FAILED",
                message="Cloudflare 凭据无效、权限不足或与账户不匹配。",
                status_code=502,
            )
        if status_code == 429:
            return AppError(
                code="WORKERS_AI_RATE_LIMITED",
                message="Cloudflare Workers AI 请求频率受限，请稍后重试。",
                status_code=503,
            )
        return AppError(
            code="WORKERS_AI_UPSTREAM_ERROR",
            message="Cloudflare Workers AI 暂时无法完成探针请求。",
            status_code=502,
        )
