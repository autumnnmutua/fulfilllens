export interface HealthResponse {
  status: "ok";
  service: string;
  version: string;
}

export interface VersionResponse {
  app_name: string;
  app_version: string;
  api_version: string;
  environment: string;
  contract_versions: {
    data: string;
    metrics: string;
    status: string;
    diagnostics: string;
    simulation: string;
    cases: string;
    reports: string;
  };
}

export interface ApiErrorDetail {
  field?: string;
  message: string;
  type?: string;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    request_id: string;
    details: ApiErrorDetail[];
  };
}
