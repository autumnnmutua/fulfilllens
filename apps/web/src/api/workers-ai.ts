import type {
  WorkersAIProbeResult,
  WorkersAIStatus,
} from "../types/integrations";
import { apiRequest } from "./client";

export const workersAIApi = {
  status: (signal?: AbortSignal) =>
    apiRequest<WorkersAIStatus>("/api/integrations/workers-ai/status", {
      signal,
    }),
  probe: () =>
    apiRequest<WorkersAIProbeResult>("/api/integrations/workers-ai/probe", {
      headers: {
        "X-FulfillLens-External-Call": "confirm",
      },
      method: "POST",
    }),
};
