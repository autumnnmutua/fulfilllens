# Cloudflare 部署与运行边界

- 更新日期：2026-08-13
- 在线地址：<https://fulfilllens.esthertreu3724.workers.dev>
- Worker：`fulfilllens`
- 结论：自主 CSV/XLSX 在浏览器本地处理；Worker 托管 SPA 与公开合成案例 API，不接收自主文件或标准化行

## 1. 当前架构

```text
React/Vite 静态资源（Workers Static Assets）
        ├─ 自主 CSV/XLSX → 浏览器本地解析/映射/校验/指标/诊断/建议/报告
        └─ 同源 API
           TypeScript Worker ── 公开确定性合成案例 → 指标/诊断/模拟/报告
```

运行时不声明外部生成式推理 binding，不提供模型状态或探针路由，也不需要模型凭据。指标、诊断、建议、模拟和报告均由仓库内确定性代码生成。

公开品牌和 Worker 项目名已从历史名称 `fulfilllens-cn` 迁移为 `fulfilllens`。旧地址仍作为历史部署保留，不是当前文档或书签的首选。

## 2. 在线接口契约

| 路径                                   | 行为                                                           |
| -------------------------------------- | -------------------------------------------------------------- |
| `/` 及前端路由                         | 返回 React SPA，并附 CSP、禁止嵌入和权限策略等安全响应头       |
| `/health`、`/api/version`              | 返回 Worker 健康和版本契约                                     |
| `/api/cases`、`/api/imports/synthetic` | 返回公开合成案例或预览                                         |
| `/api/imports/samples`                 | 列出或下载公开合成兼容性样例                                   |
| `/api/imports/upload`                  | 返回 `BROWSER_LOCAL_IMPORT_REQUIRED`；原始文件必须在浏览器处理 |
| `/api/metrics/*`、`/api/dashboard/*`   | 对公开合成订单计算指标、筛选、明细和安全 CSV                   |
| `/api/diagnostics/*`                   | 对公开合成数据执行透明规则并返回事实、判断、谨慎原因和证据     |
| `/api/simulations/*`                   | 在合成订单/节点副本上变换并复算；自建方案不保证跨实例持久      |
| `/api/reports/*`                       | 预览和小型合成报告；运行期任务不是持久云报告系统               |
| 浏览器自主数据                         | IndexedDB 本地指标、诊断、双视图建议和报告；不调用原始上传路由 |
| 已移除的外部推理集成路由               | 返回标准 404，不保留兼容探针或隐藏调用                         |
| 未实现的其他 `/api/*`                  | 返回标准 404，不用合成结果冒充用户真实数据                     |

配置源是根目录 `wrangler.jsonc`，Worker 位于 `apps/cloudflare-worker/`。浏览器只调用同源公开接口。

## 3. 组件边界

| 当前组件           | Cloudflare 结论         | 说明                                                                             |
| ------------------ | ----------------------- | -------------------------------------------------------------------------------- |
| React + Vite       | 已实现在线版            | Workers Static Assets 托管 SPA；CSV/XLSX 自主导入在浏览器执行                    |
| 浏览器本地分析引擎 | 已实现                  | 原始文件不上传；确认后的规范化行、指标、诊断、建议和报告留在当前浏览器           |
| 合成分析适配层     | 已实现                  | TypeScript Worker 只分析内置合成案例；不能替代真实数据后端                       |
| FastAPI + Pydantic | 有条件可行              | Python Workers 仍需逐依赖 PoC；当前继续用于本地/Docker                           |
| 本地 SQLite        | 不能直接持久            | 若未来需要云端控制元数据，应重新评估 D1 和身份/删除契约                          |
| 本地 DuckDB        | 不能直接照搬            | 应先验证浏览器 DuckDB-Wasm 或 R2 分片方案，不在请求内无界载入大表                |
| 上传临时目录       | 不用于在线自主导入      | 当前自主文件不进入 Worker；未来云上传必须另行设计流式校验、R2 生命周期和用户确认 |
| 透明规则引擎       | 可复用/已部分移植       | 保持确定性；Python 与 TypeScript 契约由测试对账                                  |
| 报告任务           | 演示可用/持久版不可照搬 | 在线小型合成报告可运行；真实云任务需持久队列、状态、成品存储、访问控制和取消语义 |

官方依据：

- [React + Vite on Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/react/)
- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Python Workers](https://developers.cloudflare.com/workers/languages/python/)
- [Workers 平台限制](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 限制](https://developers.cloudflare.com/d1/platform/limits/)
- [R2 分片上传](https://developers.cloudflare.com/r2/objects/upload-objects/)

## 4. 发布凭据

- 本机部署使用 Wrangler OAuth，或在 CI 进程环境中提供最小权限的 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`；
- 发布凭据只用于部署，不属于 FulfillLens 应用运行配置；
- 浏览器不接收、打印或持久化 Cloudflare 发布凭据；
- 不把真实凭据写入 `.env`、`wrangler.jsonc`、Issue、文档或测试；
- 任何曾出现在聊天、终端历史或其他非密钥管理位置的凭据都应立即轮换。

## 5. 本地优先与云模式

当前提供三条清晰路径：

- 本地模式：FastAPI + DuckDB/SQLite，文件和分析留在用户设备；
- 在线自主导入：文件、标准化行和质量报告留在当前浏览器，确认数据用 IndexedDB 保存并可在设置页删除；
- 公开合成分析：Worker 只分析仓库内固定种子合成案例，不读取浏览器自主数据。

若未来增加真实云存储或第三方数据处理，必须另建 ADR，并在上传前展示存储位置、保留期、访问范围和清理入口；届时不得继续使用“数据不离开浏览器”的文案。

## 6. 当前限制

- 浏览器自主数据支持本地指标、诊断、行动建议和报告，但尚不支持 What-if 或跨设备同步；
- FastAPI、DuckDB 和 SQLite 仍只在本地/Docker 运行；
- 在线自建方案和合成报告任务不保证跨实例持久；
- 完整云模式尚未实现账号、授权、长期存储、大文件异步任务、费用上限和删除 SLA；
- `workers.dev` 地址没有自有域名 SLA。

## 7. 构建、验证、部署与回滚

```powershell
npm.cmd ci
npm.cmd run build:cloudflare
npm.cmd run test:cloudflare
npx.cmd --yes wrangler@4.120.0 deploy --dry-run
npm.cmd run deploy:cloudflare
```

部署前后至少验证：

1. `/`、`/health`、`/api/version` 和主要 SPA 路由；
2. 兼容性样例目录与静态文件；
3. 公开合成案例的指标、诊断、模拟和报告；
4. 真实 Chromium 中的自主 CSV 与多工作表 XLSX 浏览器本地导入；
5. 指标不可计算保护、诊断、专业行动方案、管理层简报和报告；
6. 网络中没有 `/api/imports/upload` 原始文件请求；
7. 已移除的外部推理集成路径返回标准 404；
8. Wrangler 部署输出只包含预期的静态资源绑定，不包含外部推理 binding。

回滚使用 Wrangler 的部署版本历史。回滚前后都要重新执行浏览器与 API 冒烟；不要先删除当前稳定版本再测试新版本。
