# FulfillLens v1.0.1 发布验收记录

## Release Identity

- version：`1.0.1`
- branch：`main`
- date：2026-08-10（Asia/Shanghai）
- production：<https://fulfilllens.esthertreu3724.workers.dev>
- final commit / tag：在生产复验和远程 CI 全绿后，以 annotated tag `v1.0.1^{commit}` 为准

本记录只写入实际取得的证据。Git 提交不能预先包含自己的 SHA；最终提交、Cloudflare deployment ID、GitHub Actions 与 Release URL 会在完成外部发布门槛后记录。

## Functional Acceptance

| 能力            | 结果 | 实际证据                                                                                                |
| --------------- | ---- | ------------------------------------------------------------------------------------------------------- |
| 新手快速导入    | PASS | 自主上传默认自动识别数据类型，高置信字段直接应用，中置信建议一次批量采用，完整字段表默认折叠            |
| CSV/XLSX        | PASS | UTF-8/BOM、GBK/GB18030、多 Sheet、Excel 日期、文本数字、前导零、文件类型/大小及 XLSX 主动内容限制有回归 |
| 字段语义识别    | PASS | 组合 NFKC 表头、别名、值画像、唯一性、重复规律、跨列关系和所选 Schema；无文件名白名单                   |
| 一键忽略        | PASS | 仅忽略不影响最低分析能力的非必要列；支持撤销；`ignored` 与 `unresolved` 分离，旧校验结果立即失效        |
| 必填保护        | PASS | 唯一核心候选不会被安全忽略；缺失时展示问题、原因、影响和推荐操作                                        |
| 生成/推导字段   | PASS | 缺少可信事件 ID 时稳定、唯一、可复现生成；状态从原文确定性标准化，未知值保留为 `unmapped`               |
| 日期与时区      | PASS | 中英文日期、AM/PM、显式时区、DMY/MDY 文件级推断与 date-only 精度均有回归；无 locale 静默猜测            |
| 能力驱动分析    | PASS | tracking-only 仍提供首末轨迹平均/P50/P90、状态、承运商、异常、时间线、诊断、建议与报告                  |
| OT/IF/OTIF 边界 | PASS | 缺订单承诺时间或数量时显示不可计算和所需字段，不以 `0%`、`100%` 或跨表猜测伪造                          |
| 行动建议        | PASS | 专业行动方案与管理层简报共享同一 recommendation facts、数值、证据和优先级；AI 不可用时模板正常          |
| 隐私            | PASS | 自主文件只在浏览器内存解析，确认数据只进入当前浏览器 IndexedDB；原始上传网络请求断言为 0                |

## Beginner Import Acceptance

两份用户附件只用于本轮人工兼容验收，未提交 GitHub、未进入前端 bundle、Cloudflare、CI 或发布门槛。**这两份文件不是正式版依赖。** 通用回归使用仓库内完全合成 fixture，且上传时更换文件名以验证不存在文件名特判。

| 检查项                 |                           CSV #1 |                           CSV #2 |
| ---------------------- | -------------------------------: | -------------------------------: |
| 数据类型               |                     物流轨迹数据 |                     物流轨迹数据 |
| 原始 / 解析 / 导入行   |                     54 / 54 / 54 |                     54 / 54 / 54 |
| 源字段                 |                               21 |                               21 |
| 运单 / 业务单 / 承运商 |                     10 / 10 / 10 |                     10 / 10 / 10 |
| 映射、生成或辅助推导   |                               12 |                               11 |
| 一键忽略非必要字段     |                               11 |                               11 |
| 逐字段人工确认         |                                0 |                                0 |
| 批量确认               |                                0 |                                1 |
| unresolved / blocker   |                            0 / 0 |                            0 / 0 |
| 非法时间 / 静默丢行    |                            0 / 0 |                            0 / 0 |
| 未识别状态             |                     17（非阻断） |                      7（非阻断） |
| 最终路径               | 分析、诊断、报告与双视图建议通过 | 分析、诊断、报告与双视图建议通过 |

CSV #1 高置信识别包括源事件顺序、承运商、原始状态、地点、事件时间、运单、业务单和异常；事件 ID 由系统稳定生成，签收回传、旧状态码和异常列作为辅助证据。CSV #2 高置信识别唯一 `row_key` 为事件 ID，并识别承运商、时间、地点、运单、业务单和异常；原始状态只需一次批量采用。两份文件的批次、备注、营销、设备、标签等列一次安全忽略后不再产生错误。

## Date Parsing Acceptance

统一解析器保留原始字符串、标准时间、时区和精度。以下格式均由单元回归实际覆盖：

- `2026.07.02 06:35`、`2026/7/3 14:17`、`2026年07月06日 08:05`
- `07/07/2026 09:30`、`7/2/2026 11:46 AM`、`04-07-2026 22:15`
- `2026-07-03T07:52+08:00`、`Tue Jul 07 2026 18:20:00 GMT+0800 (中国标准时间)`
- `14-Aug-2026 08:32`、`17 Aug 2026 09:44`、`22-08-2026 09:22`
- `2026年8月15日`、`14 Aug 2026`、`17/08/2026`

年月日和英文月份确定性解析；数字日期由全文件推断 DMY/MDY，只在仍有歧义时产生一次文件级选择。date-only 保留 `date` 精度，不静默补午夜后参与小时级 SLA；非法日期不强制转换。

## Recommendation Acceptance

```text
Deterministic metrics + deterministic diagnostics
                   ↓
        versioned recommendation facts
                   ↓
Professional Action Plan + Executive Brief
```

- 优先级由影响数量、偏差程度、异常频率、覆盖范围和数据可信度产生，不随机；
- 每项事实带 `fact_id`、证据、影响范围、动作、KPI、目标方向、风险和验证方法；
- 两种呈现复用同一 facts，不重新计算 KPI；指标不可计算时只给数据覆盖建议；
- AI 不参与字段映射、KPI、诊断、事实或优先级计算，也不接收原始 CSV；Workers AI 不可用时确定性模板继续工作。

## Test Evidence

| 实际命令/检查                                         | Exit code | 结果                                                                        |
| ----------------------------------------------------- | --------: | --------------------------------------------------------------------------- |
| `npm run check`                                       |         0 | format check、lint、typecheck、312 项测试及生产 build 通过                  |
| `npm run test`                                        |         0 | Web 20 files / 64 tests；Worker 14；Python/API/contracts 234                |
| `npm run audit`                                       |         0 | npm audit 与 pip-audit：0 已知漏洞                                          |
| `npm run docs:check`                                  |         0 | 350 个候选文件、60 个 Markdown 文件、链接、双语和隐私规则通过               |
| `npm run licenses:check`                              |         0 | 330 个 npm 包、77 个 Python 分发包，无阻断许可证或未知直接许可证            |
| `npm run test:browser-import:local`                   |         0 | 15 个合成场景通过；两份一次性附件另完成 17 场景人工验收；原始文件上传请求 0 |
| `npm run test:browser-import:local`（可访问性审计）   |         0 | 8 路由 × 5 视口 = 40/40；axe、键盘焦点、语义、表格和横向溢出通过            |
| `npm run smoke`                                       |         0 | API/Web/代理版本、兼容样例及全部核心 SPA 路由通过                           |
| 七条 `demo:*` 命令                                    |         0 | 导入、指标、总览、诊断、模拟、案例和报告固定合成路径全部通过                |
| `docker compose ... config/up --build` 与容器内 smoke |         0 | Docker 29.6.2；API healthy 1.0.1、Web 深链路、Web→API 代理与日志检查通过    |
| `npm run release:check`                               |         0 | 格式、lint、类型、312 项测试、构建、漏洞、文档和许可证发布链通过            |
| Cloudflare 生产浏览器复验                             |    待执行 | 部署 1.0.1 后更新                                                           |

首次 `npm run check` 发现日期解析器中一处无效临时赋值，ESLint 正确阻断；删除无效赋值并增加相同日期边界回归后，全量检查重跑成功。默认系统 Python 不含项目工具，随后明确使用 `apps/api/.venv` 执行 Python 门槛，未把环境缺失误报为通过。

## Security & Privacy

- tracked files 未发现 Token、私钥、`.env`、真实物流附件或本机绝对路径；构建、Playwright、缓存和运行数据库保持忽略；
- 原始文件只在浏览器内存解析，确认标准行只进入 IndexedDB；E2E 断言原始上传请求为 0；
- CSV 导出转义公式前缀，HTML/Markdown 动态内容转义；
- 文件类型、MIME、签名、大小、XLSX 解压、宏、公式、外部链接、路径和长文本有安全限制；
- 示例、fixture 和截图均为固定种子完全合成数据。

## Release Assets

- `docs/media/import-mapping.png`
- `docs/media/dashboard-overview.png`
- `docs/media/diagnostics-trace.png`
- `docs/media/professional-action-plan.png`
- `docs/media/executive-brief.png`
- `docs/media/scenario-comparison.png`
- `docs/media/teaching-cases.png`
- `README.md`、`README_EN.md`、`CHANGELOG.md`
- `docs/releases/v1.0.1.md`

七张截图由 v1.0.1 Cloudflare 模式生产构建、真实 Chrome 和固定合成数据生成，不是 mockup；隐私扫描与图片链接检查已通过。

## Known Limitations

1. Firefox、Safari 和物理移动设备尚未实际验证；Chrome/Chromium 是本次正式验收浏览器系列。
2. PDF 尚未达到可靠中文字体、分页和长表门槛；Markdown、自包含 HTML 和安全 CSV 是正式路径。
3. Cloudflare 浏览器自主数据暂不支持 What-if，也不跨设备同步；公开合成 What-if 与本地/Docker 完整路径可用。
4. Ant Design 单块 gzip 约 371 KiB；功能与可访问性通过，但首屏体积仍可优化。
5. 自动映射不能保证覆盖所有企业私有字段；冲突或中置信核心字段仍可能需要一次批量确认。
6. 未识别状态会保留为 `unmapped` 并降低状态覆盖率，不会被猜成正常状态。
7. 本机 Docker Desktop 本轮未把已配置的 8000/5173 端口发布到 Windows 主机；容器内部与 Nginx 代理 smoke 已通过，Linux GitHub Actions 的 Docker smoke 仍必须全绿。
8. `workers.dev` 地址没有自有域名 SLA、多租户身份或长期云存储承诺。

## Final Verdict

**BLOCKED（仅待外部门槛）**

本地核心代码、单元/集成测试、构建、依赖审计、文档与许可证门槛已经通过。正式结论将在浏览器可访问性、smoke、Docker、最终 `release:check`、Cloudflare 1.0.1 部署与生产浏览器复验、GitHub Actions 全绿后更新为 `READY FOR v1.0.1`；任一门槛失败都禁止创建 tag 或 GitHub Release。
