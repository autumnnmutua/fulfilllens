# Cloudflare 部署与 Workers AI 可行性评估

- 更新日期：2026-08-08
- 结论：在线合成演示可用独立 TypeScript Worker 适配层部署；完整本地版不能原样迁移并继续依赖本机文件系统
- 当前状态：已实现静态资源、公开确定性合成案例、指标/诊断/订单级模拟/报告接口和 Workers AI 原生绑定
- 在线地址：<https://fulfilllens-cn.esthertreu3724.workers.dev>

## 1. 结论

FulfillLens CN 已具备不接收真实业务数据的 Cloudflare 在线合成演示：

```text
React/Vite 静态资源（Workers Static Assets）
        ↓ 同源 API
TypeScript Worker ── 确定性合成案例 → 指标/诊断/订单级模拟/报告
        └────────── 原生 AI binding → Workers AI 固定合成探针
```

在线适配层只生成公开、固定规则的合成数据，不接收真实文件，不把运行期 Map 宣传成持久存储。指标使用 Type-7 分位数；What-if 先变换合成订单/节点副本再调用同一指标函数。当前 FastAPI、DuckDB、SQLite 和临时目录仍面向本机持久文件；Cloudflare Python Workers、DuckDB/Python 二进制包、内存和 CPU 限制需要单独验证。“合成在线演示 + AI 原生绑定”已实现，“当前后端零修改部署”仍不可验收。

## 1.1 当前在线演示契约

| 路径                                          | 行为                                                            |
| --------------------------------------------- | --------------------------------------------------------------- |
| `/` 及前端路由                                | 返回 React SPA，并附 CSP、禁止嵌入、权限策略等安全响应头        |
| `/health`、`/api/version`                     | 返回 Worker 健康和 `cloudflare-online-demo` 版本契约            |
| `/api/cases`、`/api/imports/synthetic`        | 只返回公开合成案例/预览；真实上传接口明确拒绝                   |
| `/api/metrics/*`、`/api/dashboard/*`          | 对确定性合成订单计算指标、筛选、明细和安全 CSV                  |
| `/api/diagnostics/*`                          | 对合成数据执行透明规则并返回事实、判断、谨慎原因和证据          |
| `/api/simulations/*`                          | 在合成订单/节点副本上变换并复算；运行期自建方案不保证跨实例持久 |
| `/api/reports/*`                              | 预览和小型合成报告；运行期任务不等同于持久云报告系统            |
| `/api/integrations/workers-ai/status`         | 只返回绑定状态、模型标识和数据策略，不返回凭据                  |
| `/api/integrations/workers-ai/probe`          | 必须有显式确认请求头，只发送固定合成短句                        |
| `/api/imports/upload` 与未实现的其他 `/api/*` | 拒绝真实上传或返回标准 404，不用合成结果冒充用户真实数据        |

配置源是根目录 `wrangler.jsonc`，Worker 位于 `apps/cloudflare-worker/`。浏览器只调用同源接口；云端推理通过 `env.AI.run()`，不需要把 REST Token 或 Account ID 注入前端。

## 2. 组件可行性

| 当前组件             | Cloudflare 结论         | 建议                                                                                                                                        |
| -------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| React + Vite         | 已实现在线演示          | 使用 Workers Static Assets，SPA 配置 `not_found_handling = "single-page-application"`                                                       |
| 合成分析适配层       | 已实现                  | TypeScript Worker 只处理内置合成案例；口径和模拟不变量有独立测试，不能替代真实数据后端                                                      |
| FastAPI + Pydantic   | 有条件可行              | Python Workers 已支持但仍为 beta；先做最小迁移 PoC 和依赖清单验证                                                                           |
| 本地 SQLite          | 不能直接持久            | 控制元数据迁到 D1；D1 提供 SQLite 语义但不是本机文件                                                                                        |
| 本地 DuckDB          | 不能直接照搬            | 优先评估浏览器本地 DuckDB-Wasm，或 R2 分片 + Worker/D1 聚合；不要在请求内把大表全部载入 128 MB 内存                                         |
| 上传临时目录         | 不能持久                | 小文件流式校验后写 R2；大文件使用直传/分片，任务状态写 D1                                                                                   |
| Workers AI REST 探针 | 本地与云端可用          | 本地 FastAPI 使用进程环境；云端使用 `AI` binding；两者都只发送固定合成短句                                                                  |
| 透明规则引擎         | 可迁移                  | 保持模型无关；先验证 Python Worker 运行时，再决定复用 Python 或移植纯规则内核                                                               |
| 阶段 9 报告任务      | 演示可用/持久版不可照搬 | 在线小型合成报告可运行；`ThreadPoolExecutor` 与进程内任务/文件不会跨 Worker 请求可靠保留，真实云模式需 Queues/Workflows + D1 状态 + R2 成品 |

官方依据：

- [React + Vite on Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/react/)
- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Python Workers](https://developers.cloudflare.com/workers/languages/python/)
- [Python Workers packages](https://developers.cloudflare.com/workers/languages/python/packages/)
- [Python Worker 文件系统语义](https://developers.cloudflare.com/workers/languages/python/stdlib/)
- [Workers 平台限制](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 限制](https://developers.cloudflare.com/d1/platform/limits/)
- [R2 分片上传](https://developers.cloudflare.com/r2/objects/upload-objects/)

## 3. Workers AI 能做什么

适合的可选任务：

- 用自然语言解释已经计算好的指标定义、分子分母和覆盖率；
- 把透明规则结果改写为教学说明或报告草稿；
- 给字段映射候选提供建议，但必须展示置信度并由用户确认；
- 基于已脱敏、最小化的规则证据回答“下一步该核查什么”；
- 在合成教学案例中作为问答助手。

不能直接授权给模型的任务：

- 计算或改写 OT/IF/OTIF、分位数、异常阈值和严重度；
- 用模型输出代替规则证据或断言经营因果；
- 默认上传姓名、手机号、地址、身份证、原始订单或整份工作簿；
- 直接删除数据、确认导入、修改阈值、导出敏感明细或发起外部操作；
- 把一次模型响应解释为“能自动完成网页所有任务”。

AI 只允许作为可选解释层，不进入指标公式、诊断规则、严重度或聚合对账。

Workers AI 支持 function calling；Cloudflare Agents 也提供 Browser 工具。但网页操作需要开发者定义白名单工具、输入 Schema、权限、审批、幂等、审计和失败恢复。模型本身不会在接入 API 后自动获得本网页的按钮和数据权限。

- [Workers AI function calling](https://developers.cloudflare.com/workers-ai/features/function-calling/)
- [Cloudflare Agents tools](https://developers.cloudflare.com/agents/concepts/tools/)
- [Agents Browser tools](https://developers.cloudflare.com/agents/tools/browser/)

## 4. 凭据与调用方式

- 本机开发/连通探针：API Token 和 Account ID 只放 `apps/api/.env`，环境变量以 `FL_` 开头；`.env` 已忽略；
- 部署后的 Worker：在 Wrangler/控制台声明 `AI` binding，通过 `env.AI.run()` 调用，不需要把 REST Token 注入浏览器；
- 浏览器：只调用同源受控 API，不接收、打印或持久化 Cloudflare Token；
- 任何已经出现在聊天、终端历史或其他非密钥管理位置的 Token 都应轮换；仓库扫描不能证明外部位置没有副本；
- 当前固定探针只发送合成哨兵文本，不读取导入数据。未来的 AI 功能必须另设数据最小化与用户确认契约。

## 5. 本地优先与云模式

“部署在 Cloudflare”与“用户数据默认不离开设备”不是同一件事。建议提供两种清晰模式：

- 本地模式：当前 FastAPI + DuckDB/SQLite，文件和分析留在用户设备；
- 云模式：用户明确确认后把数据上传到 Cloudflare，页面展示存储位置、保留期、清理入口和 AI 是否被允许访问派生证据。

云模式的首页、导入确认和设置页不得继续使用“数据不离开本机”的无条件文案。

## 6. 建议迁移顺序

1. 建立本地基线 Git 提交并推送，验证 GitHub Actions 质量与 Docker smoke；
2. 部署当前在线合成演示，验证 SPA、CSP、同源分析接口、AI binding 和回滚；
3. 在需要云端业务数据前，先完成 D1/R2 的最小数据集元数据和合成小文件 PoC；
4. 对 FastAPI/Pydantic、XLSX、DuckDB 逐依赖做 Python Workers 兼容测试；
5. 选择“Python Worker 迁移”或“TypeScript Worker + 浏览器本地分析”，形成新 ADR；
6. 用 AI binding 实现固定合成探针，验证限流、错误、用量和费用；
7. 仅在隐私评审后增加自然语言解释，并保证规则/指标仍由确定性引擎生成；
8. 进行 1 万/5 万订单、内存、CPU、失败恢复、删除和费用基线；
9. 将报告进度、取消和下载迁到云端持久任务契约，验证 R2 生命周期与敏感成品删除；
10. 先预览环境验收，再由用户明确授权生产部署。

## 7. 当前限制与发布判定

- 在线演示不接收业务数据，因此不需要 D1/R2 真实数据保留与删除策略；完整云模式仍被这些策略阻断；
- Python Workers/Containers 不是当前演示依赖，FastAPI、DuckDB 和 SQLite 仍只在本地/Docker 运行；
- 在线自建方案和报告任务只处于 Worker 运行期，不保证跨实例持久；大文件异步、费用上限、身份与访问控制未实现，不能宣传成完整 SaaS；
- 阶段 9 的进程内报告任务不能直接作为 Worker 云实现，完整云模式仍需 Queues/Workflows、D1/R2 与访问控制；
- 仓库使用 MIT 许可证；Cloudflare 和 GitHub 的真实发布状态必须以实际 CLI/API 验证为准。

## 8. 部署、验证与回滚

```powershell
npm.cmd ci
npm.cmd run build:cloudflare
npm.cmd run test:cloudflare
npm.cmd run deploy:cloudflare
```

部署进程可使用 Wrangler 本机 OAuth，或在 CI 进程环境中提供 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID`；不得把真实值写入仓库。验收至少请求 `/`、`/health`、`/api/version`、合成案例、指标、诊断、模拟、报告和 AI 状态接口，并以显式确认头调用一次固定合成探针。回滚使用 Wrangler 的部署版本历史；回滚前后都要重新执行浏览器和 API 冒烟。已经出现在聊天或终端历史的 API Token 应立即轮换。
