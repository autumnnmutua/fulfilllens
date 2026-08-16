# FulfillLens v1.1.3 发布验收记录

## Release Identity

- version：`1.1.3`
- branch：`main`
- date：2026-08-17（Asia/Shanghai）
- rollback baseline：`v1.1.2` / commit `597f3eb3a4d18ffa06d2ae9c1b331826fc72e507`
- accepted runtime commit：`be9b4c31f8cf42460ab1655ff466a09cf16b0167`
- accepted release commit：以最终 annotated tag `v1.1.3^{commit}` 为准；其相对 runtime commit 只补充本验收证据
- compatibility：`v1.0.0` 至 `v1.1.2` 的 tag、Release 与 Git 历史均未修改

## Scope and Root Cause

本补丁不改变 API、数据契约、指标公式、规则阈值、浏览器存储键或 IndexedDB Schema，只处理两个已复现问题：

1. JavaScript `Date.parse` 会将带显式时区的 2 月 30 日、4 月 31 日等不存在日期自动滚入下个月。解析器此前仅检查 `Date.parse` 是否返回有限值，可能让错误源时间进入 Mean/P50/P90 与节点耗时。
2. 浏览器分析会话此前只检查少量顶层字段。损坏缓存中的数字型数据集编号会继续传给 `.startsWith()`，导致分析页崩溃。

两项问题均先由失败的回归测试复现，再进行局部修复：时间解析先校验源年月日及时分秒；分析会话读取时校验元数据形状并清理无效会话。用户的 IndexedDB 数据不会被删除。

## Functional Regression

| 能力                   | 结果 | 验收说明                                                         |
| ---------------------- | ---- | ---------------------------------------------------------------- |
| CSV/XLSX 导入          | PASS | 自动类型、映射、忽略、校验、确认与多工作表流程保持可用           |
| 数据隔离与刷新         | PASS | 新导入会话、指纹、Demo 隔离、第二次导入与刷新回归通过            |
| OT / IF / OTIF         | PASS | 金标准仍为 4/5、5/6、3/5；不可计算值保持 `null`，不会显示为 0    |
| Mean / P50 / P90       | PASS | 金标准仍为 52/52/63 小时，分布与卡片继续使用同一批时长样本       |
| 诊断与建议             | PASS | 状态、时间和承运商 mutation 回归通过；两种建议继续使用同一 facts |
| What-if 与报告         | PASS | 纯订单/节点变换、原始数据不变性、安全导出与报告路径回归通过      |
| 旧浏览器数据           | PASS | 存储键不变；合法会话继续读取，损坏会话只清理元数据并安全回退     |
| 响应式与可访问性       | PASS | 8 路由 × 5 视口共 40 组，无 axe 违规、横向溢出或未命名交互控件   |
| Cloudflare local-first | PASS | 18 个导入/分析场景通过；网络检查确认原始文件上传请求为 0         |

## Data Accuracy

| 指标          | 人工基线       | 程序结果       | 结果 |
| ------------- | -------------- | -------------- | ---- |
| OT            | 4 / 5 = 80%    | 4 / 5 = 80%    | PASS |
| IF            | 5 / 6 = 83.33% | 5 / 6 = 83.33% | PASS |
| OTIF          | 3 / 5 = 60%    | 3 / 5 = 60%    | PASS |
| Mean 履约时长 | 52 小时        | 52 小时        | PASS |
| P50 履约时长  | 52 小时        | 52 小时        | PASS |
| P90 履约时长  | 63 小时        | 63 小时        | PASS |

测试还对账 54 条轨迹记录、10 个唯一运单与 10 个唯一业务订单，防止把事件行数误当订单数；修改一个事件时间、状态或承运商时，对应时效、状态诊断或承运商分组必须变化。

## Test Evidence

| 实际命令                                                             | Exit code | 结果                                                                                  |
| -------------------------------------------------------------------- | --------: | ------------------------------------------------------------------------------------- |
| 定向 Vitest：日期解析与分析会话                                      |         1 | 修复前按预期失败：2 个显式时区非法日期被接受，损坏会话未被拒绝                        |
| 定向 Vitest：日期解析与分析会话                                      |         0 | 修复后 2 个文件、80 项测试通过                                                        |
| `npm.cmd run release:check`                                          |         0 | format、lint、typecheck、Web 110、Worker 13、Python 228、build、audit、docs、licenses |
| `npm.cmd run test:browser-import:local`                              |         0 | 18 个本地 Worker 导入/映射/分析场景通过；原始上传请求 0                               |
| 本地 Worker 运行 `chromium_accessibility_audit.cjs`                  |         0 | 8 路由 × 5 视口共 40 组通过                                                           |
| `docker compose build --pull` + `up -d --wait` + `npm.cmd run smoke` |         0 | API/Web 健康、版本 1.1.3、主要路由及兼容 CSV/XLSX 下载通过；测试卷已清理              |
| `wrangler@4.120.0 deploy --dry-run`                                  |         0 | 读取 23 个静态资产；唯一 binding 为 `env.ASSETS`                                      |
| GitHub Actions CI `31957535674`                                      |         0 | 主质量任务、Cloudflare 浏览器导入及独立 Docker/移动端/无障碍任务均通过                |
| `npm.cmd run test:browser-import`（生产）                            |         0 | 18 个生产导入/分析场景通过；原始上传请求 0                                            |
| `npm.cmd run test:browser`（生产）                                   |         0 | 8 路由 × 5 视口共 40 组通过                                                           |

第一次并行核查中曾调用不存在的 `@fulfilllens/api` npm workspace，命令以 exit 1 结束；这是命令选择错误，不是应用测试失败。随后使用仓库定义的 `python -m pytest apps/api/tests tests`，228 项全部通过。

## Security and Privacy

- tracked 与待提交文件扫描未发现 `.env`、部署 Token、私钥、真实用户附件或个人绝对路径；
- 自主文件继续只在浏览器内解析，标准化行只写入本地 IndexedDB；生产 E2E 断言原始上传请求为 0；
- CSV 公式注入、报告转义、文件类型/MIME/签名/大小和 XLSX 主动内容限制保持不变；
- npm 与锁定 Python 依赖均为 0 个已知高等级漏洞；直接依赖无阻断或未知许可证；
- Cloudflare Worker 只绑定 `env.ASSETS`，无外部生成式推理或用户数据存储 binding。

## Cloudflare Evidence

- Worker：`fulfilllens`
- production URL：<https://fulfilllens.esthertreu3724.workers.dev>
- rollback Version ID：`cf96b56a-d22c-4167-b512-b6ac1a755848`（v1.1.2）
- accepted production Version ID：`a7820b66-d349-4850-8099-a552237000fd`
- deployed at：2026-08-17 00:11:14（Asia/Shanghai）
- accepted runtime commit：`be9b4c31f8cf42460ab1655ff466a09cf16b0167`
- bindings：仅 `env.ASSETS`
- API/route smoke：`/health`、`/api/version` 与 8 个主要 SPA 路由均返回 200 和版本 1.1.3
- browser smoke：18 个生产导入/分析场景与 40 组生产页面审计通过；无需回滚

## Release Assets

- `README.md`、`README_EN.md`、`CHANGELOG.md`、`CITATION.cff`；
- `docs/releases/v1.1.3.md` 与本验收记录；
- 既有七张真实产品截图继续与界面一致；本补丁没有改变可见业务布局，不伪造重复截图。

## Known Limitations

1. Firefox、Safari 和物理移动设备尚未实际验证；Chrome/Chromium 是正式验收浏览器系列。
2. PDF 尚未达到可靠中文字体、分页和长表门槛；Markdown、自包含 HTML 和安全 CSV 是正式路径。
3. Cloudflare 浏览器自主数据暂不支持 What-if，也不跨设备同步；本地/Docker 完整路径可用。
4. Ant Design 单块 gzip 约 371 KiB，首屏体积仍有优化空间。
5. 自动映射不能保证覆盖所有企业私有字段；会改变业务含义的关键歧义仍需要一次确认。
6. 未识别状态保留为 `unmapped` 并降低状态覆盖率，不会被猜成正常状态。
7. `workers.dev` 地址没有自有域名 SLA、多租户身份或长期云存储承诺。

## Final Verdict

**READY FOR v1.1.3**

本地、浏览器、Docker、依赖、安全、文档、Wrangler dry-run、GitHub Actions、Cloudflare 正式部署及生产浏览器复验均已通过。最终验收证据提交再次通过 CI 后，可从该不可变提交创建 `v1.1.3` annotated tag 与正式 Release。
