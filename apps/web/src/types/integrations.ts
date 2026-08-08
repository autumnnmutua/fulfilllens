export interface WorkersAIStatus {
  provider: "cloudflare_workers_ai";
  enabled: boolean;
  configured: boolean;
  model: string;
  external_data_policy: string;
}

export interface WorkersAIProbeResult {
  provider: "cloudflare_workers_ai";
  model: string;
  token_status: "active";
  reachable: true;
  sentinel_matched: boolean;
  usage: {
    prompt_tokens: number | null;
    completion_tokens: number | null;
    total_tokens: number | null;
  };
  message: string;
}
