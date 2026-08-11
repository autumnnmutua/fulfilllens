from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
APP_VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
WEB_ROOT = ROOT / "apps" / "web"
VITE_ENTRY = ROOT / "node_modules" / "vite" / "bin" / "vite.js"
API_BASE = "http://127.0.0.1:8000"
WEB_BASE = "http://127.0.0.1:5173"
BROWSER_CANDIDATES = (
    Path("C:/Program Files/Google/Chrome/Application/chrome.exe"),
    Path("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"),
    Path("C:/Program Files/Microsoft/Edge/Application/msedge.exe"),
)
DASHBOARD_DATASET_IDS = {
    "orders": "51111111-1111-4111-8111-111111111111",
    "warehouse_events": "52222222-2222-4222-8222-222222222222",
    "tracking_events": "53333333-3333-4333-8333-333333333333",
}
DIAGNOSTIC_DATASET_IDS = {
    "orders": "81111111-1111-4111-8111-111111111111",
    "warehouse_events": "82222222-2222-4222-8222-222222222222",
    "tracking_events": "83333333-3333-4333-8333-333333333333",
}


def dashboard_route() -> str:
    return (
        "/analytics?"
        f"orders_dataset_id={DASHBOARD_DATASET_IDS['orders']}&"
        f"warehouse_events_dataset_id={DASHBOARD_DATASET_IDS['warehouse_events']}&"
        f"tracking_events_dataset_id={DASHBOARD_DATASET_IDS['tracking_events']}"
    )


def diagnostics_route() -> str:
    return (
        "/diagnostics?"
        f"orders_dataset_id={DIAGNOSTIC_DATASET_IDS['orders']}&"
        f"warehouse_events_dataset_id={DIAGNOSTIC_DATASET_IDS['warehouse_events']}&"
        f"tracking_events_dataset_id={DIAGNOSTIC_DATASET_IDS['tracking_events']}"
    )


def scenarios_route() -> str:
    return (
        "/scenarios?"
        f"orders_dataset_id={DASHBOARD_DATASET_IDS['orders']}&"
        f"warehouse_events_dataset_id={DASHBOARD_DATASET_IDS['warehouse_events']}&"
        f"tracking_events_dataset_id={DASHBOARD_DATASET_IDS['tracking_events']}"
    )


def reports_route() -> str:
    return (
        "/reports?"
        f"orders_dataset_id={DASHBOARD_DATASET_IDS['orders']}&"
        f"warehouse_events_dataset_id={DASHBOARD_DATASET_IDS['warehouse_events']}&"
        f"tracking_events_dataset_id={DASHBOARD_DATASET_IDS['tracking_events']}"
    )


def seed_dashboard_data() -> None:
    sys.path.insert(0, str(ROOT / "apps" / "api"))
    from app.core.config import get_settings
    from app.datasets.store import DatasetStore
    from app.schemas.imports import DataType
    from app.simulation.models import ScenarioCreate
    from app.simulation.repository import ScenarioRepository
    from demo_diagnostics import build_fixture

    fixture = json.loads(
        (ROOT / "apps" / "api" / "tests" / "fixtures" / "gold_metrics.json").read_text(
            encoding="utf-8"
        )
    )
    get_settings.cache_clear()
    settings = get_settings()
    store = DatasetStore(
        analytics_path=settings.analytics_database,
        control_path=settings.control_database,
    )
    for data_type, key in (
        (DataType.ORDERS, "orders"),
        (DataType.WAREHOUSE_EVENTS, "warehouse_events"),
        (DataType.TRACKING_EVENTS, "tracking_events"),
    ):
        store.register(
            dataset_id=DASHBOARD_DATASET_IDS[key],
            data_type=data_type,
            task_id=f"smoke-{key}",
            rows=fixture[key],
        )
    diagnostic_rows = build_fixture()
    for dataset_id, data_type, rows in (
        (DIAGNOSTIC_DATASET_IDS["orders"], DataType.ORDERS, diagnostic_rows[0]),
        (
            DIAGNOSTIC_DATASET_IDS["warehouse_events"],
            DataType.WAREHOUSE_EVENTS,
            diagnostic_rows[1],
        ),
        (
            DIAGNOSTIC_DATASET_IDS["tracking_events"],
            DataType.TRACKING_EVENTS,
            diagnostic_rows[2],
        ),
    ):
        store.register(
            dataset_id=dataset_id,
            data_type=data_type,
            task_id=f"smoke-diagnostics-{data_type.value}",
            rows=rows,
        )
    ScenarioRepository(settings.control_database).create(
        ScenarioCreate(
            name="烟雾测试揽收改善",
            datasets={
                "orders_dataset_id": DASHBOARD_DATASET_IDS["orders"],
                "warehouse_events_dataset_id": DASHBOARD_DATASET_IDS["warehouse_events"],
                "tracking_events_dataset_id": DASHBOARD_DATASET_IDS["tracking_events"],
            },
            parameters={"pickup_improvement": {"reduction_hours": 1}},
        )
    )


def creation_flags() -> int:
    return subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def start_process(command: list[str], working_directory: Path) -> subprocess.Popen[str]:
    return subprocess.Popen(
        command,
        cwd=working_directory,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=creation_flags(),
    )


def request(url: str) -> tuple[int, bytes]:
    http_request = Request(
        url,
        headers={
            "Accept": "application/json, text/html",
            "User-Agent": "FulfillLens-Smoke/1.0.0",
        },
    )
    with urlopen(http_request, timeout=3) as response:
        return response.status, response.read()


def request_json(url: str) -> dict[str, Any]:
    status, body = request(url)
    if status != 200:
        raise RuntimeError(f"{url} 返回 HTTP {status}")
    payload = json.loads(body)
    if not isinstance(payload, dict):
        raise RuntimeError(f"{url} 未返回 JSON 对象")
    return payload


def wait_until_ready(processes: list[subprocess.Popen[str]]) -> None:
    for _ in range(30):
        failed = next((process for process in processes if process.poll() is not None), None)
        if failed is not None:
            output = failed.stdout.read() if failed.stdout is not None else ""
            raise RuntimeError(f"服务进程提前退出（{failed.returncode}）：\n{output}")

        try:
            request(f"{API_BASE}/health")
            request(f"{WEB_BASE}/")
            return
        except (TimeoutError, URLError):
            time.sleep(1)

    raise RuntimeError("本地服务未在 30 秒内就绪")


def stop_process(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def capture_viewport_screenshots() -> dict[str, int]:
    artifact_value = os.environ.get("FL_SMOKE_SCREENSHOT_DIR")
    if not artifact_value:
        return {}
    browser = next((candidate for candidate in BROWSER_CANDIDATES if candidate.is_file()), None)
    if browser is None:
        raise RuntimeError("已要求视口截图，但未找到 Chrome 或 Edge")
    artifact_dir = Path(artifact_value).resolve()
    artifact_dir.mkdir(parents=True, exist_ok=True)
    results: dict[str, int] = {}
    with TemporaryDirectory(prefix="fulfilllens-browser-profile-") as profile:
        profile_root = Path(profile)
        # Windows headless Chromium enforces a roughly 500 px minimum outer width.
        # 500 px still exercises the project's <=575 px mobile CSS breakpoint.
        viewports = (("mobile", "500,2400"), ("desktop", "1440,2400"))
        pages = (
            ("cases", "/cases"),
            ("analytics", dashboard_route()),
            ("diagnostics", diagnostics_route()),
            ("scenarios", scenarios_route()),
            ("reports", reports_route()),
            ("settings", "/settings"),
        )
        for page, route in pages:
            for label, size in viewports:
                result_key = f"{page}-{label}"
                screenshot = artifact_dir / f"{result_key}.png"
                user_data_dir = profile_root / result_key
                completed = subprocess.run(
                    [
                        str(browser),
                        "--headless=new",
                        "--disable-gpu",
                        "--force-device-scale-factor=1",
                        "--hide-scrollbars",
                        "--no-first-run",
                        "--virtual-time-budget=3000",
                        f"--user-data-dir={user_data_dir}",
                        f"--window-size={size}",
                        f"--screenshot={screenshot}",
                        f"{WEB_BASE}{route}",
                    ],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=30,
                    check=False,
                    creationflags=creation_flags(),
                )
                if completed.returncode != 0 or not screenshot.is_file():
                    raise RuntimeError(
                        f"{result_key} 视口截图失败：{completed.stdout}\n{completed.stderr}"
                    )
                results[result_key] = screenshot.stat().st_size
    return results


def main() -> None:
    node = shutil.which("node")
    if node is None:
        raise RuntimeError("未找到 Node.js")
    if not VITE_ENTRY.is_file():
        raise RuntimeError("未安装前端依赖，请先运行 npm install")

    with TemporaryDirectory(prefix="fulfilllens-smoke-runtime-") as temporary:
        runtime = Path(temporary)
        environment = {
            "FL_IMPORT_ROOT": str(runtime / "imports"),
            "FL_ANALYTICS_DATABASE": str(runtime / "analytics.duckdb"),
            "FL_CONTROL_DATABASE": str(runtime / "control.sqlite3"),
            "FL_ENVIRONMENT": "test",
        }
        previous_environment = {key: os.environ.get(key) for key in environment}
        os.environ.update(environment)
        seed_dashboard_data()
        api = start_process(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "app.main:app",
                "--app-dir",
                "apps/api",
                "--host",
                "127.0.0.1",
                "--port",
                "8000",
            ],
            ROOT,
        )
        web = start_process(
            [
                node,
                str(VITE_ENTRY),
                "--host",
                "127.0.0.1",
                "--port",
                "5173",
                "--strictPort",
            ],
            WEB_ROOT,
        )

        try:
            wait_until_ready([api, web])
            direct_health = request_json(f"{API_BASE}/health")
            direct_version = request_json(f"{API_BASE}/api/version")
            proxy_health = request_json(f"{WEB_BASE}/health")
            proxy_version = request_json(f"{WEB_BASE}/api/version")
            compatibility_samples = request_json(f"{WEB_BASE}/api/imports/samples")
            home_status, home_body = request(f"{WEB_BASE}/")
            compatibility_csv_status, _ = request(f"{WEB_BASE}/compatibility_demo_orders.csv")
            compatibility_xlsx_status, _ = request(f"{WEB_BASE}/compatibility_demo_logistics.xlsx")
            import_route_status, _ = request(f"{WEB_BASE}/import")
            analytics_route_status, _ = request(f"{WEB_BASE}{dashboard_route()}")
            diagnostics_route_status, _ = request(f"{WEB_BASE}{diagnostics_route()}")
            scenarios_route_status, _ = request(f"{WEB_BASE}{scenarios_route()}")
            reports_route_status, _ = request(f"{WEB_BASE}{reports_route()}")
            cases_route_status, cases_body = request(f"{WEB_BASE}/cases")

            assert direct_health["status"] == "ok"
            assert proxy_health["status"] == "ok"
            assert direct_version["app_version"] == APP_VERSION
            assert proxy_version["api_version"] == "v1"
            assert len(compatibility_samples["samples"]) == 2
            assert home_status == 200
            assert compatibility_csv_status == 200
            assert compatibility_xlsx_status == 200
            assert b"FulfillLens" in home_body
            assert import_route_status == 200
            assert analytics_route_status == 200
            assert diagnostics_route_status == 200
            assert scenarios_route_status == 200
            assert reports_route_status == 200
            assert cases_route_status == 200
            assert b"FulfillLens" in cases_body
            screenshots = capture_viewport_screenshots()

            print(
                json.dumps(
                    {
                        "api_health": direct_health["status"],
                        "api_version": direct_version["app_version"],
                        "proxy_health": proxy_health["status"],
                        "proxy_api_version": proxy_version["api_version"],
                        "compatibility_sample_count": len(compatibility_samples["samples"]),
                        "compatibility_csv_status": compatibility_csv_status,
                        "compatibility_xlsx_status": compatibility_xlsx_status,
                        "web_status": home_status,
                        "import_route_status": import_route_status,
                        "analytics_route_status": analytics_route_status,
                        "diagnostics_route_status": diagnostics_route_status,
                        "scenarios_route_status": scenarios_route_status,
                        "reports_route_status": reports_route_status,
                        "cases_route_status": cases_route_status,
                        "viewport_screenshots": screenshots,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
        finally:
            stop_process(web)
            stop_process(api)
            for key, previous_value in previous_environment.items():
                if previous_value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = previous_value


if __name__ == "__main__":
    main()
