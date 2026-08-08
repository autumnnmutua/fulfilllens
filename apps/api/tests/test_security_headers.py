from fastapi.testclient import TestClient


def test_api_responses_disable_sniffing_framing_referrers_and_caching(
    client: TestClient,
) -> None:
    response = client.get("/api/version")

    assert response.status_code == 200
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert response.headers["cache-control"] == "no-store"


def test_unexpected_errors_do_not_expose_tracebacks(client: TestClient) -> None:
    response = client.delete("/api/datasets/not-a-canonical-uuid")

    assert response.status_code in {404, 422}
    body = response.text.lower()
    assert "traceback" not in body
    assert "apps/api" not in body
