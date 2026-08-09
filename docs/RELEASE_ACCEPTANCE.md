# FulfillLens v1.0.0 最终验收记录

## Release Identity

- version：`1.0.0`
- accepted implementation commit：`d495327a5aa53622f95fcaddc15017379c471b35`
- branch：`main`
- date：2026-08-10（Asia/Shanghai）
- production：<https://fulfilllens.esthertreu3724.workers.dev>
- tag target：最终发布证据提交；精确 SHA 以远程 annotated tag `v1.0.0^{commit}` 和发布报告为准

验收提交包含正式代码、测试、版本、七张生产截图和发布说明；本记录作为随后唯一的发布证据提交。由于 Git 提交不能在自身内容中预先写入自身 SHA，最终 tag SHA 不伪造为占位值。

## Functional Acceptance

| 能力                 | 验收结果         | 证据摘要                                                                                              |
| -------------------- | ---------------- | ----------------------------------------------------------------------------------------------------- |
| CSV/XLSX 导入        | PASS             | UTF-8/BOM、GBK/GB18030、多 Sheet、Excel 日期、文本数字、前导零、文件类型/大小与 XLSX 安全限制均有回归 |
| 自动映射与人工复核   | PASS             | Exact/Alias/Normalized/Similarity/Manual、高置信度批量推荐、低置信度人工确认                          |
| 一键安全忽略         | PASS             | 仅忽略无关键线索且无中等候选的非分析列；支持撤销；ignored 不再进入错误数量                            |
| Required protection  | PASS             | `order_id` 等必填字段不能被忽略绕过；缺失时显示问题、原因、影响和建议操作                             |
| Generated / inferred | PASS             | 缺失轨迹事件 ID 时稳定派生；`raw_status` 确定性生成 `event_code`；未知状态保持 `unmapped`             |
| 质量校验             | PASS             | 映射变化废弃旧报告；忽略列问题消失；真实阻断保留；确认状态只有一个可信来源                            |
| 指标                 | PASS             | OT/IF/OTIF、P50/P90、节点、异常和覆盖率对账；tracking-only 不伪造 OT/IF/OTIF                          |
| 诊断                 | PASS             | 透明规则、阈值、事实/判断/可能原因分层、订单证据和样本警告                                            |
| 行动建议             | PASS             | Professional Action Plan 与 Executive Brief 共享 fact ID、数字、优先级和证据；AI 不可用时模板可用     |
| What-if              | PASS（边界公开） | 本地/Docker 与公开合成案例可用；浏览器自主数据暂不支持，页面和文档均未夸大                            |
| 报告                 | PASS             | Markdown、自包含 HTML、安全 CSV；建议章节跟随同一事实；PDF 明确保留为未支持                           |
| 案例与清理           | PASS             | 三套固定种子合成案例；API/IndexedDB 清理入口；不含真实 PII                                            |

## Non-standard CSV Acceptance

持续回归使用仓库公开的完全合成 fixture `tests/fixtures/nonstandard_tracking_user.csv`，测试会在上传时改名，证明没有文件名白名单。它覆盖中文非标准表头、列顺序变化、多种时间、状态别名、附加列、推荐映射、安全忽略、Schema、确认导入以及浏览器本地分析。

用户曾指定的 54×21 非标准物流 CSV 是一次性人工兼容性附件。本轮工作区未提供该附件，因此未伪造 54 行、21 列、10 order/shipment/carrier 的逐行复验值；其缺失不影响生产、Cloudflare、CI 或发布。**该文件不是正式版依赖。**

| 检查项               | 通用正式回归结果                                          |
| -------------------- | --------------------------------------------------------- |
| 源文件名依赖         | 0；测试上传时使用不同文件名                               |
| 静默丢行             | 0；解析行数与标准化输入逐行对账                           |
| 必填字段误忽略       | 0；唯一必填候选受保护                                     |
| ignored / unresolved | 语义与计数分离；前者不进入标准行，后者继续提示            |
| tracking event ID    | 无可信源列时稳定、唯一、可复现生成                        |
| 时间                 | 支持主要现实格式；歧义日期拒绝或提示，不依赖服务器 locale |
| 状态                 | 保留 `raw_status`；确定性映射或 `unmapped`，不丢事件      |
| 下游指标             | 只有轨迹表时 OT/IF/OTIF 为不可计算，并说明需补订单字段    |

## Recommendation Acceptance

数据流为：

```text
Deterministic metrics + deterministic diagnostics
                   ↓
        versioned recommendation facts
                   ↓
Professional Action Plan + Executive Brief
```

- 优先级由影响订单、偏差、异常频率、覆盖范围和数据可信度产生，不随机；
- 每项事实包含 `fact_id`、证据、影响范围、建议动作、KPI、目标方向、风险和验证方法；
- 两个视图引用同一 facts，不重新计算 KPI；
- 指标不可计算时只给数据覆盖建议，不输出伪业务结论；
- 不能证明的原因使用谨慎表述；AI 不参与 KPI、规则、异常或优先级计算；
- Cloudflare 浏览器路径不上传原始 CSV 或标准化行，Workers AI 不可用时确定性模板正常显示。

## Test Evidence

| 实际命令/检查                                                                | Exit code | 结果                                                                     |
| ---------------------------------------------------------------------------- | --------: | ------------------------------------------------------------------------ |
| `npm run format`                                                             |         0 | 前端、Worker、Python 和 Markdown 已格式化                                |
| `npm run check`                                                              |         0 | format check、lint、typecheck、298 项测试及生产 build 通过               |
| `npm run test`                                                               |         0 | Web 20 files / 50 tests；Worker 14；Python/API/contracts 234             |
| `npm run audit`                                                              |         0 | npm 高危门槛与 pip-audit：0 已知漏洞                                     |
| `npm run licenses:check`                                                     |         0 | 330 个 npm 包、77 个 Python 分发包，无阻断或未知直接许可证               |
| `npm run test:browser-import`（生产）                                        |         0 | 15 场景通过；CSV/XLSX/忽略/必填/建议/报告/刷新；原始上传请求 0           |
| `npm run test:browser`（生产）                                               |         0 | 8 路由 × 5 视口 = 40/40；axe、键盘焦点、语义、溢出均通过                 |
| `docker compose -p fulfilllens-v100-final config --quiet`                    |         0 | Compose 配置有效                                                         |
| `docker compose -p fulfilllens-v100-final up --build --detach`               |         0 | API healthy、API 1.0.0、Web `/analytics` 200、日志无错误；卷和网络已清理 |
| `npm run release:check`                                                      |         0 | 最终格式、lint、类型、测试、构建、漏洞、文档和许可证发布链通过           |
| `npm run smoke`                                                              |         0 | API/Web/代理、版本、兼容样例与全部核心 SPA 路由通过                      |
| `npm run demo:import/metrics/dashboard/diagnostics/simulation/cases/reports` |         0 | 七条真实合成数据演示全部通过；报告示例包含双视图建议                     |

## Performance

阶段 10 的固定合成基线仍适用于相同机器与代码路径，不是硬件 SLA：

|                     规模 | CSV 解析 | 三表写入 |   指标 |   诊断 |    模拟 |    HTML |    峰值 RSS |
| -----------------------: | -------: | -------: | -----: | -----: | ------: | ------: | ----------: |
|  10,000 单 / 20,000 事件 |   0.067s |   0.442s | 0.817s | 1.496s |  3.153s |  2.743s |   363.3 MiB |
| 50,000 单 / 100,000 事件 |   0.213s |   1.172s | 4.568s | 8.928s | 18.859s | 17.971s | 1,345.3 MiB |

5 万单预算为写入 60s、指标 90s、诊断/模拟各 120s、HTML 90s、峰值 2,048 MiB，已记录基线全部通过。

## Cloudflare Evidence

- Worker：`fulfilllens`
- URL：<https://fulfilllens.esthertreu3724.workers.dev>
- accepted deployment version ID：`cd59d85e-a395-4567-91f4-c2e73b4d02ca`
- deployment date：2026-08-10（Asia/Shanghai）
- `/health`：`ok`，version `1.0.0`
- `/api/version`：`app_version=1.0.0`，`environment=cloudflare-online-demo`
- Workers AI：原生 `AI` binding configured；固定合成探针 reachable 且 sentinel matched；不读取用户文件
- production browser：15/15 导入场景及 40/40 路由/视口组合通过

## Security & Privacy

- tracked files 未发现 Cloudflare/GitHub Token、私钥或 `.env`；`data/local`、构建、Playwright 和缓存产物保持忽略；
- 自主文件原始内容仅在浏览器内存处理，确认标准行只进入当前浏览器 IndexedDB，网络断言原始上传请求为 0；
- CSV 导出 UTF-8 BOM 并转义公式前缀，HTML/Markdown 动态内容转义；
- 文件类型、MIME、签名、大小、XLSX 解压、路径、宏、公式、外部链接和长文本有安全限制；
- 示例、fixture 和截图均为完全合成数据，不含真实姓名、手机号、地址、身份证、企业订单或凭据；
- AI 只允许可选表达辅助，不计算 KPI 或诊断，也不默认接收用户数据。

## Release Assets

- `docs/media/import-mapping.png`
- `docs/media/dashboard-overview.png`
- `docs/media/diagnostics-trace.png`
- `docs/media/professional-action-plan.png`
- `docs/media/executive-brief.png`
- `docs/media/scenario-comparison.png`
- `docs/media/teaching-cases.png`
- `README.md`、`README_EN.md`、`CHANGELOG.md`
- `docs/releases/v1.0.0.md` 与 GitHub 治理模板

七张图片均由最终 Cloudflare 生产构建、固定合成数据和真实 Chrome 自动拍摄并人工检查；不是 mockup。GIF 未生成且不是发布阻断项。

## Defects Fixed in Final Gate

| 严重度 | 根因                                                                    | 修复与回归                                                                |
| ------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 高     | ignored 与缺映射校验未统一，产生大量逐行伪错误                          | 缺标准映射只产生一条 actionable 阻断；ignored 问题不计数；单元与 E2E 覆盖 |
| 高     | 浏览器本地派生订单 sentinel 被当作 IndexedDB 数据集读取，导入后分析白屏 | 显式排除派生 ID 并规范化缺失值；真实生产 CSV→分析回归                     |
| 高     | 只有 tracking events 时可能诱导用户阅读不存在的订单 KPI                 | OT/IF/OTIF 返回不可计算与所需字段说明；测试断言不出现 0%/100% 伪值        |
| 中     | 浏览器报告不同 CSV 类型复用同一订单内容，订单导出仍指向远程 URL         | 按用途生成本地安全 CSV；导出和报告 E2E 覆盖                               |
| 中     | 动态 HTML 报告标题/摘要未统一转义                                       | 统一 HTML 实体转义；报告安全测试                                          |
| 中     | 建议辅助文本颜色导致生产 axe 对比度失败                                 | 使用正文色和非颜色标签；40/40 生产审计通过                                |
| 中     | 首次截图请求发生部署传播竞态                                            | 不降低断言；生产 E2E确认稳定后重跑并取得七张真实资产                      |

## Known Limitations

1. Firefox、Safari 和物理移动设备尚未实际验证；Chrome/Chromium 是正式验收浏览器系列。
2. PDF 尚未达到可靠中文字体、分页和长表门槛；Markdown、自包含 HTML 和安全 CSV 是正式路径。
3. Cloudflare 浏览器自主数据暂不支持 What-if，也不跨设备同步；公开合成 What-if 与本地/Docker 完整路径可用。
4. Ant Design 单块 gzip 约 371 KiB；功能与可访问性通过，但首屏体积仍可继续优化。
5. 5 万订单峰值约 1.35 GiB；低内存设备应降低规模或分批导入。
6. `workers.dev` 地址绑定 Worker 名称，但没有自有域名可用性 SLA、多租户身份或长期云存储承诺。
7. 自动映射不保证覆盖所有企业私有字段；中低置信度和冲突候选仍需人工确认。

## Final Verdict

**READY FOR v1.0.0**

本机、Docker 和 Cloudflare 生产门槛均通过；没有失败测试、高严重度未修复安全问题、静默丢行、必填绕过或伪造 KPI。最终 tag 和正式 GitHub Release 仍必须等待本记录提交后的 main GitHub Actions 全绿；若远程 CI 失败，结论自动回退为 BLOCKED，先修复再发布。
