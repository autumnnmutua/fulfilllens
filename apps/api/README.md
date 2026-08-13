# FulfillLens API

FastAPI 本地 API。阶段 9 提供系统、导入、可复算履约指标、统一筛选仪表盘、透明诊断、可复现 What-if 情景模拟和安全报告导出接口。

默认监听 `127.0.0.1:8000`：

- `GET /health`
- `GET /api/version`
- `GET /docs`
- `POST /api/imports/upload`
- `POST /api/imports/synthetic`
- `POST /api/imports/{task_id}/parse`
- `PUT /api/imports/{task_id}/validation`
- `POST /api/imports/{task_id}/confirm`
- `GET /api/metrics/summary`
- `GET /api/metrics/trend`
- `GET /api/metrics/distribution`
- `GET /api/metrics/breakdown`
- `GET /api/metrics/orders/{order_id}`
- `GET /api/dashboard/overview`
- `GET /api/dashboard/orders`
- `GET /api/dashboard/orders.csv`
- `GET /api/diagnostics/rules`
- `POST /api/diagnostics/analyze`
- `POST /api/diagnostics/orders/search`
- `POST /api/diagnostics/orders/{order_id}`
- `GET /api/simulations/parameters`
- `POST /api/simulations/baseline`
- `GET/POST /api/simulations/scenarios`
- `PATCH/DELETE /api/simulations/scenarios/{scenario_id}`
- `POST /api/simulations/scenarios/{scenario_id}/copy`
- `POST /api/simulations/run`
- `POST /api/simulations/sensitivity`
- `GET /api/reports/capabilities`
- `POST /api/reports/preview`
- `POST /api/reports/jobs`
- `GET/DELETE /api/reports/jobs/{job_id}`
- `GET /api/reports/jobs/{job_id}/download`

在仓库根目录创建并激活虚拟环境后运行：

```powershell
python -m uvicorn app.main:app --app-dir apps/api --reload --host 127.0.0.1 --port 8000
```

设置项见 `.env.example`。默认 CORS 只允许本机 Web 开发源，配置中禁止通配符 `*`。

导入任务默认保存于仓库已忽略的 `data/local/imports/`。详细格式、安全限制、状态机与清理规则见 [`docs/IMPORTING.md`](../../docs/IMPORTING.md)。

确认导入后，标准行进入 `data/local/analytics.duckdb`，数据集控制元数据进入 `data/local/control.sqlite3`。指标口径和人工对照见 [`docs/METRICS.md`](../../docs/METRICS.md) 与 [`docs/GOLD_METRICS.md`](../../docs/GOLD_METRICS.md)。

诊断规则来自 `data/rules/diagnostic_rules.v1.json`，API 返回事实、规则判断、谨慎可能原因、证据和建议核查。规则边界、去重与对账见 [`docs/DIAGNOSTICS.md`](../../docs/DIAGNOSTICS.md)。

模拟器只变换订单/事件副本并重新调用指标引擎；方案元数据进入 SQLite，原始标准表保持只读。参数、公式、重采样和误用边界见 [`docs/SIMULATION.md`](../../docs/SIMULATION.md)。

API 不集成外部生成式推理接口。指标、诊断、建议和报告均使用项目内确定性实现；Cloudflare 发布凭据不属于应用运行配置。

报告 API 使用同一筛选集合复用指标、诊断和模拟，默认掩码订单/事件标识。Markdown、自包含 HTML、五类 CSV、进度/取消、PDF 准入条件和示例报告见 [`docs/REPORTING.md`](../../docs/REPORTING.md)。
