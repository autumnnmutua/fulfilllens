import { handleOnlineDemoApi } from "./online-demo";

const APP_VERSION = "1.1.2";
const API_VERSION = "v1";

interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
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

async function apiResponse(request: Request): Promise<Response | null> {
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
        data: "1.1.0",
        metrics: "1.1.0",
        status: "1.0.0",
        diagnostics: "1.0.0",
        simulation: "1.0.0",
        cases: "1.0.0",
        reports: "1.0.0",
      },
    });
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
    const handled = await apiResponse(request);
    if (handled !== null) {
      return handled;
    }
    return withAssetSecurityHeaders(await env.ASSETS.fetch(request));
  },
};
