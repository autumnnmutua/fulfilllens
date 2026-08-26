# FulfillLens v1.1.4 发布验收记录

## Release Identity

- version：`1.1.4`
- branch：`main`
- date：2026-08-26（Asia/Shanghai）
- rollback baseline：`v1.1.3` / commit `71d4dbe4fc440942176ad61845b424e8841fceec`
- accepted runtime commit：`62089dc2809b7d07a5906355e415d688dc3a8a65`
- accepted release commit：以最终 annotated tag `v1.1.4^{commit}` 为准；相对 runtime commit 只允许补充验收证据
- compatibility：`v1.0.0` 至 `v1.1.3` 的 tag、Release 与 Git 历史均不修改

## Scope and Root Cause

本补丁不改变 API、数据契约、指标公式、规则阈值、浏览器数据库名称、对象仓库或数据集结构，只修复两个已复现的边界问题：

1. JavaScript 会把部分非法显式时区偏移自动归一化。解析器此前验证日历与时分秒，但没有独立限制偏移小时和分钟，可能让 `+14:30`、`GMT+1460` 等错误源时间进入时效指标。
2. IndexedDB 单个请求的 `success` 事件并不代表整个事务已提交。数据集存储此前在请求成功时就向调用方返回，并且先修改内存缓存；如果事务随后中止，页面会短暂读取到实际未持久化的数据。事务创建异常时还可能遗漏连接关闭。

两项问题均先用失败回归测试复现，再局部修复：显式偏移限制为有效范围；浏览器数据集只在事务 `complete` 后同步内存，错误、中止和事务创建失败统一关闭连接并保留错误。现有 IndexedDB 数据不会被迁移或删除。

## Functional Regression

| 能力                   | 结果 | 验收说明                                                           |
| ---------------------- | ---- | ------------------------------------------------------------------ |
| CSV/XLSX 导入          | PASS | 自动类型、映射、忽略、校验、确认、多工作表和非法文件拒绝保持可用   |
| 本地持久化与刷新       | PASS | 事务提交后才报告成功；失败数据不进入内存缓存；刷新持久化路径通过   |
| OT / IF / OTIF         | PASS | 金标准与不可计算语义保持不变，缺数据不会显示为 0                   |
| Mean / P50 / P90       | PASS | 日期解析、同源分布和 mutation 回归通过，非法偏移不会进入指标       |
| 诊断与建议             | PASS | 当前数据集的时间、状态和承运商变化继续驱动对应诊断与建议           |
| What-if 与报告         | PASS | 原始数据不变性、安全导出、报告和两种建议视图保持可用               |
| 响应式与可访问性       | PASS | 8 路由 × 5 视口共 40 组，无 axe 违规、横向溢出或未命名交互控件     |
| Cloudflare local-first | PASS | 18 个导入/分析场景通过，网络检查确认原始文件与标准化行上传请求为 0 |

## Test Evidence

| 实际命令                                | Exit code | 结果                                                                                  |
| --------------------------------------- | --------: | ------------------------------------------------------------------------------------- |
| 定向 Vitest：非法时区偏移               |         1 | 修复前按预期失败：运行时接受非法 GMT/ISO 偏移                                         |
| 定向 Vitest：IndexedDB 事务             |         1 | 修复前按预期失败：事务中止仍报告成功，事务创建失败未关闭连接                          |
| 修复后定向 Vitest                       |         0 | 日期与存储回归全部通过                                                                |
| `npm.cmd run release:check`             |         0 | format、lint、typecheck、Web 117、Worker 13、Python 228、build、audit、docs、licenses |
| `npm.cmd run test:browser-import:local` |         0 | 18 个本地 Worker 导入/映射/分析场景通过；原始上传请求 0                               |
| 本地 Chromium 页面审计                  |         0 | 8 路由 × 5 视口共 40 组通过                                                           |
| `npm.cmd run smoke`                     |         0 | API/Web、版本、代理、兼容样例与主要路由通过                                           |
| `docker compose config --quiet`         |         0 | Compose 配置有效                                                                      |
| GitHub Actions run `32932992396`        |         0 | 质量 job 与独立 Docker 构建/启动/健康/浏览器/只读资产 smoke 全部通过                  |
| 生产 `test:browser-import`              |         0 | Cloudflare 上 18 个 CSV/XLSX、映射、分析、持久化场景通过；原始上传请求 0              |
| 生产 Chromium 页面审计                  |         0 | 8 路由 × 5 视口共 40 组通过，无 axe 违规、横向溢出或未命名交互控件                    |

首次 CI run `32932069423` 暴露了浏览器 E2E 在重复访问同一路由时复用旧页面状态的问题；修复为每次导航使用独立运行标识并检查导航响应后，定向浏览器测试、本地全量门槛及上述独立 CI 均重新通过。

## Security and Privacy

- tracked 与待提交文件扫描不得包含 `.env`、部署 Token、私钥、真实用户附件或本机绝对路径；
- 自主文件继续只在浏览器内解析，标准化行只写入本地 IndexedDB；浏览器 E2E 断言原始上传请求为 0；
- CSV 公式注入、XSS、文件类型/MIME/签名/大小和 XLSX 主动内容限制保持不变；
- npm 与锁定 Python 依赖为 0 个已知高等级漏洞；直接依赖无阻断或未知许可证；
- Cloudflare Worker 仅允许静态资源绑定，不添加外部生成式推理或用户数据存储 binding。

## Cloudflare Evidence

- Worker：`fulfilllens`
- production URL：<https://fulfilllens.esthertreu3724.workers.dev>
- rollback Version ID：`8717da49-5280-4dd2-a94a-0864a20d5736`（v1.1.3）
- accepted production Version ID：`4d8e5eda-c452-4067-9348-c41a76343c00`
- deployed at：2026-08-26 13:16:42（Asia/Shanghai）
- bindings：仅 `env.ASSETS`
- production smoke：`/health`、`/api/version`、8 个 SPA 路由、18 个浏览器导入场景与 40 组页面审计全部通过；`/api/version` 返回 `1.1.4`

## Release Assets

- `README.md`、`README_EN.md`、`CHANGELOG.md`、`CITATION.cff`；
- `docs/releases/v1.1.4.md` 与本验收记录；
- 既有真实产品截图继续适用；本补丁没有改变用户可见布局，不使用旧图冒充新界面。

## Known Limitations

1. Firefox、Safari 和物理移动设备尚未实际验证；Chrome/Chromium 是正式验收浏览器系列。
2. PDF 尚未达到可靠中文字体、分页和长表门槛；Markdown、自包含 HTML 和安全 CSV 是正式路径。
3. Cloudflare 浏览器自主数据暂不支持 What-if，也不跨设备同步；本地/Docker 完整路径可用。
4. Ant Design 仍有弃用提示，且主依赖分块较大；属于后续兼容与性能改进项，不影响本补丁数据正确性。
5. 自动映射不能保证覆盖所有企业私有字段；会改变业务含义的关键歧义仍需要一次确认。
6. 未识别状态保留为 `unmapped` 并降低状态覆盖率，不会被猜成正常状态。
7. 本机 Docker 引擎未运行；独立 GitHub Actions Docker job 已完成构建、启动、健康、浏览器与只读资产 smoke，未使用或删除本机既有数据卷。
8. `workers.dev` 地址没有自有域名 SLA、多租户身份或长期云存储承诺。

## Final Verdict

**READY FOR v1.1.4**

本地静态、单元、集成、浏览器与运行态检查、GitHub Actions（含独立 Docker）、Wrangler 正式部署和生产浏览器复验均已通过。最终验收证据提交相对 accepted runtime commit 仅修改本文档；该提交再次通过 CI 后可创建 annotated tag 与正式 GitHub Release。
