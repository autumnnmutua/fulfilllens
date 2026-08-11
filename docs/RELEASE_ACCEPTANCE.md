# FulfillLens v1.1.0 发布验收记录

## Release Identity

- version：`1.1.0`
- branch：`main`
- date：2026-08-11（Asia/Shanghai）
- accepted application commit：`19e350bfeb66d4268a8b19c32c4c3bc3e021c3d7`
- accepted commit：以最终 annotated tag `v1.1.0^{commit}` 为准
- base release：`v1.0.0` 标签、GitHub Release 与历史不修改

## Functional Acceptance

| 能力           | 结果 | 证据                                                                                          |
| -------------- | ---- | --------------------------------------------------------------------------------------------- |
| 导入与新手路径 | PASS | 自动类型、高置信映射、安全 ID、非必要列与校验由“一键整理并分析”一次执行；高级映射仍可审查     |
| 数据集隔离     | PASS | 新用户会话清理旧 Demo/兼容样例选择；显式 URL 参数视为完整数据包，不回退混入旧来源             |
| 分析指纹       | PASS | 总览、诊断和报告共享同一 `analysis_fingerprint`；不同输入、时间/status/carrier 变更会改变结果 |
| 部分数据分析   | PASS | 仅运单/时间/原始状态即可分析首末跨度、P50/P90、状态和时间线；carrier/location 只控制对应能力  |
| 指标不可计算   | PASS | tracking-only 的 OT、IF、OTIF 为 `null/不可计算`，不显示 0% 或借用跨表字段                    |
| 多表关联       | PASS | 主动组合订单与事件时输出关联数/孤立事件/关联率；关联率为 0 时拒绝静默组合                     |
| 诊断与建议     | PASS | 未知状态不直接算经营异常；建议只消费当前可计算 facts，专业方案与管理层简报共享证据            |
| 报告与追溯     | PASS | 报告、指标抽屉和上下文条显示来源、指纹、样本、时间范围与版本                                  |
| 本地优先       | PASS | 浏览器 E2E 记录原始文件上传请求 0；标准化数据仅写入当前浏览器 IndexedDB                       |
| 示例一致性     | PASS | CSV/XLSX 行数、目录摘要、SHA-256、Schema、时序和下载内容由回归测试对账                        |

## Beginner Import Acceptance

| 检查项                 |       CSV #1 |       CSV #2 |
| ---------------------- | -----------: | -----------: |
| 源行 / 源列            |      54 / 21 |      54 / 21 |
| 自动识别数据类型       |     物流轨迹 |     物流轨迹 |
| 解析 / 导入 / 静默丢行 |  54 / 54 / 0 |  54 / 54 / 0 |
| 运单 / 业务单 / 承运商 | 10 / 10 / 10 | 10 / 10 / 10 |
| 映射或生成字段         |           12 |           11 |
| 一键忽略字段           |           11 |           11 |
| unresolved / blocker   |        0 / 0 |        0 / 0 |
| 非法时间 / 未知状态    |       0 / 17 |        0 / 7 |
| 逐字段 / 批量确认      |        0 / 0 |        0 / 0 |
| 原始文件网络上传       |            0 |            0 |

两份附件仅用于本轮人工兼容验收，未提交 GitHub、未进入生产包，也不是 CI、Cloudflare 或 Release 依赖。自动化回归使用仓库内完全合成 fixture。

## A/B Accuracy

| 项目              | CSV #1                                                                    | CSV #2                                                                    |
| ----------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 时间范围          | 2026-07-01 至 2026-07-09                                                  | 2026-08-12 至 2026-08-22                                                  |
| Mean 首末轨迹跨度 | 33.6400 h                                                                 | 30.7782 h                                                                 |
| P50               | 29.8333 h                                                                 | 31.7817 h                                                                 |
| P90               | 58.9900 h                                                                 | 34.0402 h                                                                 |
| 浏览器显示        | 33.6 / 29.8 / 59.0 h                                                      | 30.8 / 31.8 / 34.0 h                                                      |
| 分析指纹          | `sha256-1c0f16cde24ba7787e364bf02d038864019968c81120cbfb614c00d2106680c3` | `sha256-282963259d925695280be6637c89f8cea8d353d2e4e52241b344cf52ddb4f42c` |
| 异常率            | 40.0%                                                                     | 50.0%                                                                     |
| 建议差异          | P90-P50 长尾约 29.2 h；优先核查 4/10 异常运单                             | 分布较集中；优先核查 5/10 异常运单并补充订单 KPI 数据                     |

独立复算以每个 `shipment_id` 的最大事件时间减最小事件时间形成 10 个样本，再按线性插值定义计算 P50/P90。浏览器程序值与独立复算一致；两份文件的指纹、时间范围、Mean/P50/P90、诊断和建议均不同。

## Partial Data Matrix

| 输入覆盖             | 可分析                                                               | 明确不可用                 |
| -------------------- | -------------------------------------------------------------------- | -------------------------- |
| 完整订单 + 事件      | OT/IF/OTIF、履约时效、维度、异常、诊断、建议、报告                   | 仅按实际空值降低相应覆盖率 |
| tracking-only        | 运单数、事件数、首末跨度、Mean/P50/P90、状态、时间线、异常、数据质量 | OT/IF/OTIF                 |
| tracking 缺 carrier  | tracking-only 能力保持                                               | 承运商对比                 |
| tracking 缺 location | tracking-only 能力保持                                               | 节点/地点分析              |
| 部分状态未知         | 已识别状态、时间与其他能力保持；未知值保留 `raw_status`/`unmapped`   | 未知行不伪造标准状态       |

## Date Parsing Acceptance

确定性解析回归覆盖 `07/07/2026 09:30`、`2026年8月15日`、`14 Aug 2026`、`14-Aug-2026 08:32`、`17 Aug 2026 09:44`、`22-08-2026 09:22`、`17/08/2026`、`2026-08-14T16:26:08+08:00`、`2026.07.02 06:35`、`7/2/2026 11:46 AM` 和 `Tue Jul 07 2026 18:20:00 GMT+0800 (中国标准时间)`。date-only 保留精度，非法值不静默强转；整列仍有 DMY/MDY 歧义时只请求一次文件级选择。

## Sample Expansion

| 公开合成样例                    | 旧行数 | v1.1.0 行数 | SHA-256                                                            |
| ------------------------------- | -----: | ----------: | ------------------------------------------------------------------ |
| `compatibility_demo_orders.csv` |      8 |          80 | `26b43ebda76714b0cd64bb437761028d8001e7600f97d135e336df06dc601c0b` |
| XLSX `订单数据`                 |      6 |          80 | 同一工作簿见下行                                                   |
| XLSX `仓库事件`                 |     36 |         480 | 同一工作簿见下行                                                   |
| XLSX `物流轨迹`                 |     36 |         480 | `ae2366b059a35e22a0c198d4c21a7f025d51ff4e8cd3af5bffb00bd84e23cab0` |

生成器固定输入并规范化 XLSX ZIP 时间戳；重复生成得到相同 SHA-256。三套教学案例未增加、删除或改变体系。

## Test Evidence

| 实际命令                                              | Exit code | 结果                                                                                                         |
| ----------------------------------------------------- | --------: | ------------------------------------------------------------------------------------------------------------ |
| `npm run release:check`                               |         0 | format、lint、TypeScript/mypy、333 项测试、生产构建、npm/pip audit、文档与许可证检查全部通过                 |
| `npm run test:browser-import:local`（含两份本地附件） |         0 | 19 场景；6 个映射视口、CSV/XLSX、会话隔离、刷新、报告、必填保护与 A/B 分析通过                               |
| `npm run test:browser`                                |         0 | 8 个路由 × 5 个视口，共 40 组 Chromium 可访问性、键盘、语义与横向溢出检查通过                                |
| `npm run smoke`                                       |         0 | API、Web 代理、版本、主要 SPA 路由和两份兼容性示例下载通过                                                   |
| `docker compose config/build/up --wait` + 宿主机探测  |         0 | Docker 29.6.2；API/Web 容器健康，宿主机 `/health` 与 `/api/version` 均返回 1.1.0，容器已停止并清理临时运行卷 |
| `wrangler deploy --dry-run`                           |         0 | 23 个静态资产、Worker 与 AI/ASSETS bindings 校验通过                                                         |
| Cloudflare 正式部署与生产浏览器 A/B                   |         0 | Worker 1.1.0；19 个生产浏览器场景通过，两份 54×21 CSV 均零丢行、零阻断、零逐字段确认，原始文件上传请求为 0   |
| GitHub Actions CI `31453650030`                       |         0 | 质量、测试、构建、Cloudflare 浏览器导入与 Docker 构建/烟雾测试两个任务全部通过                               |

## Security & Privacy

- tracked files 不得包含 Token、私钥、`.env`、本机路径或两份用户附件；
- 原始文件仅在页面内存解析，确认后的标准行写入 IndexedDB；E2E 断言上传请求 0；
- CSV 导出防公式注入，报告动态内容转义；文件类型、MIME、签名、大小和 XLSX 主动内容受限；
- 示例、fixture 和截图均为固定种子完全合成数据；
- recommendation facts 只使用聚合指标与诊断证据，AI 不计算 KPI、不读取原始文件，且不可用时模板继续工作。

## Cloudflare Evidence

- Worker：`fulfilllens`
- production URL：<https://fulfilllens.esthertreu3724.workers.dev>
- deployment ID：`20794534-5427-4b64-82ab-3eb13129d7aa`
- version ID：`34973221-e771-48fd-8537-2b87ff204ef2`
- deployed at：2026-08-11 10:57:41（Asia/Shanghai）
- production smoke：`/health`、`/api/version`、8 个 SPA 路由、两份兼容样例、Workers AI 固定合成探针和 19 个浏览器导入/A/B 场景全部通过；版本为 1.1.0，Workers AI 探针使用 71 tokens 且未发送业务数据。

## Release Assets

- 七张真实生产构建截图：导入、总览、诊断、专业行动方案、管理层简报、情景对比、教学案例；
- `README.md`、`README_EN.md`、`CHANGELOG.md`；
- `docs/IMPORTING.md`、`docs/ARCHITECTURE.md`、`docs/COMPATIBILITY_VALIDATION.md`；
- `docs/releases/v1.1.0.md`。

## Known Limitations

1. Firefox、Safari 和物理移动设备尚未实际验证；Chrome/Chromium 是正式验收浏览器系列。
2. PDF 尚未达到可靠中文字体、分页和长表门槛；Markdown、自包含 HTML 和安全 CSV 是正式路径。
3. Cloudflare 浏览器自主数据暂不支持 What-if，也不跨设备同步；公开合成 What-if 与本地/Docker 完整路径可用。
4. Ant Design 单块 gzip 约 371 KiB，首屏体积仍可优化。
5. 自动映射不能保证覆盖所有企业私有字段；会改变业务含义的中置信冲突仍需要一次确认。
6. 未识别状态保留为 `unmapped` 并降低状态覆盖率，不会被猜成正常状态。
7. `workers.dev` 地址没有自有域名 SLA、多租户身份或长期云存储承诺。

## Final Verdict

**READY FOR v1.1.0**

本地与远端质量门槛、Docker、Cloudflare 正式部署、Workers AI 固定合成探针和生产 A/B 浏览器复验均已通过。最终验收证据提交再次通过 GitHub Actions 后，可创建 `v1.1.0` annotated tag 与正式 Release。
