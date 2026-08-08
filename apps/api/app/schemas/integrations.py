from typing import Literal

from pydantic import BaseModel


class WorkersAIStatusResponse(BaseModel):
    provider: Literal["cloudflare_workers_ai"] = "cloudflare_workers_ai"
    enabled: bool
    configured: bool
    model: str
    external_data_policy: str = "仅允许显式合成探针；不会自动发送导入数据或个人信息。"


class WorkersAIUsage(BaseModel):
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    total_tokens: int | None = None


class WorkersAIProbeResponse(BaseModel):
    provider: Literal["cloudflare_workers_ai"] = "cloudflare_workers_ai"
    model: str
    token_status: Literal["active"]
    reachable: Literal[True] = True
    sentinel_matched: bool
    usage: WorkersAIUsage
    message: str
