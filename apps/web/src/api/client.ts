import type {
  ApiErrorResponse,
  HealthResponse,
  VersionResponse,
} from "../types/api";

const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim() ?? "";
const apiBaseUrl = configuredBaseUrl.replace(/\/+$/, "");

export class ApiClientError extends Error {
  readonly code: string;
  readonly details: ApiErrorResponse["error"]["details"];
  readonly requestId?: string;
  readonly status: number;

  constructor(
    message: string,
    options: {
      code: string;
      details?: ApiErrorResponse["error"]["details"];
      status: number;
      requestId?: string;
    },
  ) {
    super(message);
    this.name = "ApiClientError";
    this.code = options.code;
    this.details = options.details ?? [];
    this.status = options.status;
    this.requestId = options.requestId;
  }
}

function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return false;
  }

  const error = value.error;
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    "message" in error &&
    typeof error.message === "string"
  );
}

interface RequestOptions {
  body?: BodyInit;
  headers?: HeadersInit;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  signal?: AbortSignal;
}

export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  let response: Response;
  const headers = new Headers({
    Accept: "application/json",
  });
  new Headers(options.headers).forEach((value, key) => {
    headers.set(key, value);
  });

  if (typeof options.body === "string") {
    headers.set("Content-Type", "application/json");
  }

  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      body: options.body,
      headers,
      method: options.method ?? "GET",
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }

    throw new ApiClientError("无法连接本地 API，请确认服务已经启动。", {
      code: "NETWORK_ERROR",
      status: 0,
    });
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    if (isApiErrorResponse(payload)) {
      throw new ApiClientError(payload.error.message, {
        code: payload.error.code,
        details: payload.error.details,
        status: response.status,
        requestId: payload.error.request_id,
      });
    }

    throw new ApiClientError(`本地 API 返回错误（HTTP ${response.status}）。`, {
      code: "INVALID_ERROR_RESPONSE",
      status: response.status,
    });
  }

  return payload as T;
}

export const systemApi = {
  health: (signal?: AbortSignal) =>
    apiRequest<HealthResponse>("/health", { signal }),
  version: (signal?: AbortSignal) =>
    apiRequest<VersionResponse>("/api/version", { signal }),
};

export function apiDownloadUrl(path: string): string {
  return `${apiBaseUrl}${path}`;
}
