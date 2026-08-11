from fastapi.testclient import TestClient


def test_health_smoke(client: TestClient) -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "fulfilllens-api",
        "version": "1.1.0",
    }
    assert response.headers["X-Request-ID"]


def test_version_exposes_contract_versions(client: TestClient) -> None:
    response = client.get("/api/version")

    assert response.status_code == 200
    assert response.json() == {
        "app_name": "FulfillLens",
        "app_version": "1.1.0",
        "api_version": "v1",
        "environment": "test",
        "contract_versions": {
            "data": "data-contract-v1.1.0",
            "metrics": "metrics-v1.1.0",
            "status": "status-v1.0-draft",
            "diagnostics": "diagnostics-v1.0.0",
            "simulation": "simulation-v1.0.0",
            "cases": "teaching-cases-v1.0.0",
            "reports": "report-v1.0.0",
        },
    }


def test_unknown_route_uses_standard_error_response(client: TestClient) -> None:
    response = client.get(
        "/api/not-implemented",
        headers={"X-Request-ID": "test-request-001"},
    )

    assert response.status_code == 404
    assert response.headers["X-Request-ID"] == "test-request-001"
    assert response.json() == {
        "error": {
            "code": "NOT_FOUND",
            "message": "请求的资源不存在。",
            "request_id": "test-request-001",
            "details": [],
        }
    }


def test_cors_allows_only_configured_development_origin(
    client: TestClient,
) -> None:
    allowed = client.options(
        "/health",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "X-FulfillLens-External-Call",
        },
    )
    denied = client.options(
        "/health",
        headers={
            "Origin": "https://untrusted.example",
            "Access-Control-Request-Method": "GET",
        },
    )

    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert "X-FulfillLens-External-Call" in allowed.headers["access-control-allow-headers"]
    assert "access-control-allow-origin" not in denied.headers


def test_openapi_documents_success_and_standard_error_contracts(
    client: TestClient,
) -> None:
    openapi = client.get("/openapi.json").json()

    assert (
        openapi["paths"]["/health"]["get"]["responses"]["200"]["content"]["application/json"][
            "schema"
        ]["$ref"]
        == "#/components/schemas/HealthResponse"
    )
    assert (
        openapi["paths"]["/health"]["get"]["responses"]["404"]["content"]["application/json"][
            "schema"
        ]["$ref"]
        == "#/components/schemas/ErrorResponse"
    )
