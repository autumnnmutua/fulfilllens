# 架构决策记录（ADR）

ADR 用于记录影响多个模块、数据口径或长期维护成本的关键决定。它不能替代代码、测试或产品文档，但应解释“为什么这样做”和“何时重新评估”。

## 状态

- Proposed：提议中，尚不可作为既定约束；
- Accepted：当前采用；
- Superseded：已被新 ADR 取代；
- Rejected：评估后不采用；
- Deprecated：仍可能存在，但不应继续扩展。

## 编写规则

1. 文件名使用 `NNNN-short-title.md`；
2. 包含状态、日期、背景、决定、理由、后果、替代方案和复审条件；
3. 不覆盖旧决定；改变方向时新增 ADR 并标记取代关系；
4. 指标、数据、规则或模拟口径改变时，同时更新相应规范和测试；
5. ADR 不得包含密钥、个人信息、真实订单或机器专用绝对路径。

## 索引

| ADR                                                   | 标题                                | 状态     | 日期       |
| ----------------------------------------------------- | ----------------------------------- | -------- | ---------- |
| [0001](0001-project-structure-and-tooling.md)         | 项目结构与基础工具链                | Accepted | 2026-07-29 |
| [0002](0002-frontend-backend-boundary.md)             | 前后端边界与契约                    | Accepted | 2026-07-29 |
| [0003](0003-local-first-runtime.md)                   | 本地优先运行模式                    | Accepted | 2026-07-29 |
| [0004](0004-duckdb-sqlite-responsibilities.md)        | DuckDB 与 SQLite 职责分离           | Accepted | 2026-07-29 |
| [0005](0005-explainable-rule-engine.md)               | 可解释规则引擎                      | Accepted | 2026-07-29 |
| [0006](0006-data-privacy-minimization.md)             | 数据隐私分级与最小化                | Accepted | 2026-07-29 |
| [0007](0007-frontend-routing-security.md)             | 前端路由与依赖安全基线              | Accepted | 2026-07-29 |
| [0008](0008-local-and-cloudflare-runtime-boundary.md) | 本地运行与 Cloudflare 云模式边界    | Accepted | 2026-08-01 |
| [0009](0009-order-level-reproducible-simulation.md)   | 订单与事件层可复现情景模拟          | Accepted | 2026-08-01 |
| [0010](0010-auditable-local-report-exports.md)        | 可审计的本地报告导出与 PDF 准入条件 | Accepted | 2026-08-01 |
