from fastapi.testclient import TestClient


def test_dataset_cleanup_purges_related_scenarios_and_analysis(client: TestClient) -> None:
    loaded = client.post("/api/cases/normal_operations/load")
    assert loaded.status_code == 201
    datasets = loaded.json()["datasets"]
    scenario = client.post(
        "/api/simulations/scenarios",
        json={"name": "清理验证方案", "datasets": datasets, "parameters": {}},
    )
    assert scenario.status_code == 201

    listed = client.get("/api/datasets")
    assert listed.status_code == 200
    assert listed.json()["total"] == 3
    assert {item["source_kind"] for item in listed.json()["datasets"]} == {"synthetic_case"}

    target = datasets["tracking_events_dataset_id"]
    expected_rows = next(
        item["row_count"] for item in listed.json()["datasets"] if item["dataset_id"] == target
    )
    deleted = client.delete(f"/api/datasets/{target}")
    assert deleted.status_code == 200, deleted.text
    assert deleted.json() == {
        "dataset_id": target,
        "data_type": "tracking_events",
        "rows_deleted": expected_rows,
        "scenarios_deleted": 1,
        "report_jobs_deleted": 0,
        "import_artifacts_deleted": False,
        "message": "本地数据集及其关联缓存已清理，操作不可撤销。",
    }

    after = client.get("/api/datasets").json()
    assert after["total"] == 2
    assert target not in {item["dataset_id"] for item in after["datasets"]}
    assert (
        client.get(
            "/api/simulations/scenarios",
            params={"orders_dataset_id": datasets["orders_dataset_id"]},
        ).json()
        == []
    )
    assert client.get("/api/metrics/summary", params=datasets).status_code == 404
    assert client.delete(f"/api/datasets/{target}").status_code == 404


def test_dataset_cleanup_rejects_non_canonical_identifiers(client: TestClient) -> None:
    response = client.delete("/api/datasets/../../outside")
    assert response.status_code in {404, 422}
