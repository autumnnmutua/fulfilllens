import { handleOnlineDemoApi } from "./online-demo";

const APP_VERSION = "1.0.0-rc.5";
const API_VERSION = "v1";
const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const PROBE_SENTINEL = "FULFILLLENS_WORKERS_AI_OK";

interface WorkersAIBinding {
  run(model: string, input: unknown): Promise<unknown>;
}

interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  AI: WorkersAIBinding;
  ASSETS: AssetsBinding;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function errorResponse(
  code: string,
  message: string,
  status: number,
): Response {
  return jsonResponse(
    {
      error: {
        code,
        message,
        request_id: crypto.randomUUID(),
        details: [],
      },
    },
    status,
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function optionalTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

async function probeWorkersAI(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("X-FulfillLens-External-Call") !== "confirm") {
    return errorResponse(
      "EXTERNAL_CALL_CONFIRMATION_REQUIRED",
      "执行外部连接探针前必须显式确认。",
      403,
    );
  }

  try {
    const rawResult = await env.AI.run(MODEL, {
      messages: [
        {
          role: "system",
          content:
            "You are a connectivity probe. Never request or reveal user data.",
        },
        {
          role: "user",
          content: `Reply with exactly ${PROBE_SENTINEL}`,
        },
      ],
      max_tokens: 32,
      temperature: 0,
    });
    const result = asRecord(rawResult);
    const responseText = result?.response;
    if (typeof responseText !== "string" || responseText.trim().length === 0) {
      return errorResponse(
        "WORKERS_AI_INVALID_RESPONSE",
        "Cloudflare Workers AI 返回了无法识别的响应。",
        502,
      );
    }
    const usage = asRecord(result?.usage);
    const sentinelMatched = responseText.trim() === PROBE_SENTINEL;
    return jsonResponse({
      provider: "cloudflare_workers_ai",
      model: MODEL,
      token_status: "active",
      reachable: true,
      sentinel_matched: sentinelMatched,
      usage: {
        prompt_tokens: optionalTokenCount(usage?.prompt_tokens),
        completion_tokens: optionalTokenCount(usage?.completion_tokens),
        total_tokens: optionalTokenCount(usage?.total_tokens),
      },
      message: sentinelMatched
        ? "Workers AI 原生绑定与固定合成探针均通过。"
        : "Workers AI 可访问，但模型未严格返回固定探针文本。",
    });
  } catch {
    return errorResponse(
      "WORKERS_AI_UPSTREAM_ERROR",
      "Cloudflare Workers AI 暂时无法完成探针请求。",
      502,
    );
  }
}

async function apiResponse(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return jsonResponse({
      status: "ok",
      service: "fulfilllens-cloudflare-worker",
      version: APP_VERSION,
    });
  }
  if (request.method === "GET" && url.pathname === "/api/version") {
    return jsonResponse({
      app_name: "FulfillLens",
      app_version: APP_VERSION,
      api_version: API_VERSION,
      environment: "cloudflare-online-demo",
      contract_versions: {
        data: "1.0.0",
        metrics: "1.1.0",
        status: "1.0.0",
        diagnostics: "1.0.0",
        simulation: "1.0.0",
        cases: "1.0.0",
        reports: "1.0.0",
      },
    });
  }
  if (
    request.method === "GET" &&
    url.pathname === "/api/integrations/workers-ai/status"
  ) {
    return jsonResponse({
      provider: "cloudflare_workers_ai",
      enabled: true,
      configured: true,
      model: MODEL,
      external_data_policy:
        "原生 AI 绑定；在线演示只处理公开合成数据。Workers AI 探针仅在用户确认后发送固定短句，不发送业务数据或个人信息。",
    });
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/integrations/workers-ai/probe"
  ) {
    return probeWorkersAI(request, env);
  }
  const onlineDemoResponse = await handleOnlineDemoApi(request, url, {
    json: jsonResponse,
    error: errorResponse,
  });
  if (onlineDemoResponse !== null) {
    return onlineDemoResponse;
  }
  if (url.pathname.startsWith("/api/")) {
    return errorResponse(
      "ONLINE_DEMO_API_NOT_FOUND",
      "该在线演示接口不存在。",
      404,
    );
  }
  return null;
}

function withAssetSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  );
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const handled = await apiResponse(request, env);
    if (handled !== null) {
      return handled;
    }
    return withAssetSecurityHeaders(await env.ASSETS.fetch(request));
  },
};
