# FulfillLens v1.1.2 发布验收记录

## Release Identity

- version：`1.1.2`
- branch：`main`
- date：2026-08-13（Asia/Shanghai）
- base release：`v1.1.1`
- accepted commit：以最终 annotated tag `v1.1.2^{commit}` 为准
- compatibility：`v1.0.0`、`v1.1.0`、`v1.1.1` 的 tag、Release 与 Git 历史均不修改

## Scope

本补丁移除独立的外部生成式推理集成，不改变导入、映射、校验、指标、诊断、行动建议、What-if、教学案例、报告或数据清理的确定性业务链路。

| 移除面             | 验收结果 | 证据                                                           |
| ------------------ | -------- | -------------------------------------------------------------- |
| Cloudflare binding | PASS     | `wrangler.jsonc` 无推理 binding；dry-run 只列出 `env.ASSETS`   |
| Worker 路由        | PASS     | 状态/探针实现删除；两个旧路径均返回标准 404                    |
| FastAPI            | PASS     | 客户端、配置、Schema、路由和环境变量删除；OpenAPI 不再注册集成 |
| Web                | PASS     | 设置页只管理本地数据；API client、类型、探针 UI 与确认状态删除 |
| 凭据               | PASS     | 应用运行时不读取模型 Account ID、Token、模型名或超时配置       |
| 文档               | PASS     | 中英文 README、架构、部署、安全、FAQ、导入和风险边界同步更新   |
| 负向回归           | PASS     | 契约测试扫描关键运行文件，不允许隐藏调用或 binding 重新出现    |

## Functional Regression

| 能力           | 结果 | 验收说明                                                                          |
| -------------- | ---- | --------------------------------------------------------------------------------- |
| 自主导入       | PASS | 浏览器本地 CSV/XLSX 解析、自动映射、安全忽略、校验、确认和 IndexedDB 保存保持可用 |
| 指标与分布     | PASS | OT/IF/OTIF 不可计算保护、Mean/P50/P90、时长分箱和节点耗时回归通过                 |
| 数据集隔离     | PASS | 当前分析会话、指纹、Demo 隔离、刷新与第二次导入回归通过                           |
| 透明诊断       | PASS | 确定性规则、订单证据、状态与承运商变化回归通过                                    |
| 行动建议       | PASS | 专业行动方案和管理层简报继续消费同一 recommendation facts，无外部服务依赖         |
| What-if        | PASS | 订单/节点变换后重算的既有实现和契约测试通过                                       |
| 报告与导出     | PASS | 浏览器本地报告、建议章节、安全 CSV 与 HTML/Markdown 主路径回归通过                |
| 设置与清理     | PASS | 本地/浏览器数据集列表、不可逆删除确认、分析会话清理和错误可见性保留               |
| 响应式与无障碍 | PASS | 8 路由 × 5 视口均无 axe 违规、无横向溢出、无未命名交互控件                        |

## Test Evidence

| 实际命令                                                      | Exit code | 结果                                                                                    |
| ------------------------------------------------------------- | --------: | --------------------------------------------------------------------------------------- |
| `npm.cmd ci`                                                  |         0 | 依赖按 lockfile 安装；npm 报告 0 漏洞                                                   |
| `python -m pip install -r apps/api/requirements-dev.txt`      |         0 | Python 运行与测试依赖安装成功                                                           |
| `npm.cmd run check`                                           |         0 | 格式、ESLint/Ruff、TypeScript/mypy、Web 107、Worker 13、Python 228 项测试与生产构建通过 |
| `npm.cmd run audit`                                           |         0 | npm 与项目锁定 Python requirements 均为 0 已知漏洞                                      |
| `npm.cmd run docs:check`                                      |         0 | 348 个候选文件、61 个 Markdown、链接、命令、隐私和发布资产通过                          |
| `npm.cmd run licenses:check`                                  |         0 | 330 个 npm 包、181 个 Python 分发包；无阻断/未知直接依赖许可证                          |
| `npm.cmd run test:browser-import:local`                       |         0 | 18 个 Chromium 导入/映射/忽略/分析/诊断/报告/刷新场景通过，原始上传请求 0               |
| `FL_BROWSER_SCRIPT=chromium_accessibility_audit.cjs` 本地运行 |         0 | 8 路由 × 360/390/430/768/1440 共 40 组通过                                              |
| `npm.cmd run smoke`                                           |         0 | API/Web、1.1.2 版本、主要路由及兼容 CSV/XLSX 下载通过                                   |
| `docker compose build/up --wait` + 宿主机探测                 |         0 | Docker 29.6.2；API/Web 健康，版本 1.1.2，设置页无旧入口，旧 API 为 404；专用卷已清理    |
| `wrangler@4.120.0 deploy --dry-run`                           |         0 | 读取 23 个静态资产；唯一运行绑定为 `env.ASSETS`                                         |

首次审计在 Windows 中文用户路径上因 `pip-api` 错误按 UTF-8 解码本机输出而失败；设置 UTF-8 后又发现原命令错误包含全局 Jupyter 等非项目软件。现已使用 `scripts/audit_python.py` 固定 UTF-8，并只审计锁定的 `apps/api/requirements-dev.txt`；项目依赖结果为 0 已知漏洞，未忽略任何项目包。

首次临时 Docker 项目探测使用了与 Compose 顶层兼容名称冲突的项目覆盖，且默认项目一度复用旧镜像。最终严格按 README 的 `docker compose build`、`up -d --wait` 从当前源码重建，确认 API 返回 1.1.2 后才计为通过。

## Security & Privacy

- tracked files 扫描不得包含 Token、私钥、`.env`、本机路径或真实用户附件；
- 自主文件仍只在浏览器内解析，确认后的标准行写入 IndexedDB；E2E 断言原始上传请求 0；
- Cloudflare 发布凭据只用于 Wrangler/CI 部署，不属于应用运行配置；
- CSV 导出防公式注入，报告动态内容转义，文件类型/MIME/签名/大小/XLSX 主动内容限制不变；
- 指标、诊断、建议、模拟和报告均由确定性代码产生，不依赖外部生成式推理。

## Cloudflare Evidence

- Worker：`fulfilllens`
- production URL：<https://fulfilllens.esthertreu3724.workers.dev>
- pre-deploy validation：PASS，dry-run 只显示 `env.ASSETS`
- production deploy/version：待候选提交与 CI 通过后记录
- production smoke：待部署后执行

## Release Assets

- `README.md`、`README_EN.md`、`CHANGELOG.md`、`CITATION.cff`；
- `docs/CLOUDFLARE_DEPLOYMENT.md`、`docs/ARCHITECTURE.md`、`docs/FAQ.md`；
- `docs/releases/v1.1.2.md`；
- 七张既有真实生产构建截图继续有效；本补丁删除设置页功能，不需要伪造新的业务截图。

## Known Limitations

1. Firefox、Safari 和物理移动设备尚未实际验证；Chrome/Chromium 是正式验收浏览器系列。
2. PDF 尚未达到可靠中文字体、分页和长表门槛；Markdown、自包含 HTML 和安全 CSV 是正式路径。
3. Cloudflare 浏览器自主数据暂不支持 What-if，也不跨设备同步；本地/Docker 完整路径可用。
4. Ant Design 单块 gzip 约 371 KiB，首屏体积仍可优化。
5. 自动映射不能保证覆盖所有企业私有字段；会改变业务含义的关键歧义仍需要一次确认。
6. 未识别状态保留为 `unmapped` 并降低状态覆盖率，不会被猜成正常状态。
7. `workers.dev` 地址没有自有域名 SLA、多租户身份或长期云存储承诺。

## Final Verdict

**LOCAL RELEASE GATE PASSED；PRODUCTION DEPLOYMENT PENDING**

本地代码、浏览器、Docker、依赖、安全、文档与 Wrangler dry-run 门槛均已通过。只有 Cloudflare 正式部署、生产浏览器复验和 GitHub Actions 通过后，才把结论更新为 `READY FOR v1.1.2` 并创建正式 tag/Release。
