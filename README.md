# FulfillLens CN

[English](README_EN.md) · [文档索引](docs/README.md) · [10 分钟快速体验](#10-分钟快速体验) · [贡献](CONTRIBUTING.md) · [安全](SECURITY.md)

FulfillLens CN 是面向物流管理专业学生、教师和中小电商商家的本地优先开源履约分析工具。用户导入订单、仓库作业和物流轨迹 CSV/XLSX 后，可以完成字段映射、状态标准化、指标计算、瓶颈分析、透明异常诊断、What-if 情景模拟和报告导出。

项目的核心不是“自动讲一个听起来合理的故事”，而是让每个百分比、异常和模拟结果都能回到字段、公式、阈值、样本和具体订单证据。

> 版本状态：`1.0.0-rc.1` 发布候选准备中。Cloudflare 在线预览使用静态资源、同源 Worker API 与原生 Workers AI 绑定；完整数据分析仍以本地或 Docker 为主。Firefox/Safari 和 PDF 仍有发布前验收项，详见[项目状态](#项目状态与已知限制)。

## 为什么使用 FulfillLens CN

- **本地优先**：默认在用户设备上处理文件，不要求外部数据库或付费物流接口。
- **口径透明**：OT、IF、OTIF、P50、P90、覆盖率等均展示字段依赖、分子、分母和警告。
- **证据可追溯**：诊断区分事实、规则判断、可能原因和建议核查，可下钻到订单时间线。
- **模拟不冒充预测**：改进方案在订单/事件层应用可解释变换后重算，显著标注为情景估算。
- **适合教学**：提供三套固定种子合成案例、案例教材和无需真实数据的完整流程。
- **安全可验证**：包含文件安全、隐私清理、公式注入防护、自动化测试、性能和可访问性基线。

## 截图与演示

当前没有把缺失截图伪造成已完成资产。发布前将实际拍摄以下页面：导入向导、分析总览、异常追溯、模拟对比和教学案例。拍摄内容、隐私要求和状态见[截图与 GIF 清单](docs/SCREENSHOTS.md)。

无需截图也可以完整体验：启动后打开 <http://127.0.0.1:5173/cases>，载入“正常运营”“促销爆单”或“承运商异常”合成案例。

## 核心能力

| 模块       | 用户可以完成什么                                         | 重要边界                               |
| ---------- | -------------------------------------------------------- | -------------------------------------- |
| 数据导入   | 导入 CSV/XLSX、选择编码/工作表、预览、字段映射、质量校验 | 不执行宏和公式；未知编码需确认         |
| 状态标准化 | 保存原始状态、标准状态、来源和置信度，增加项目级映射     | 未知状态保留并标记 `unmapped`          |
| 履约指标   | 查看 OT、IF、OTIF、时效、节点、取消、退回、异常和覆盖率  | 不可计算订单不混入成功/失败分母        |
| 分析总览   | 趋势、分布、节点耗时、仓库/承运商/地区对比和订单明细     | 图表显示样本量、单位、覆盖率和文字摘要 |
| 异常诊断   | 八类透明规则、严重度、帕累托、流程变体、订单证据         | 可能原因不是已证实因果                 |
| What-if    | 改善仓内、揽收等待、承运商比例和承诺时效，查看敏感性     | 情景估算，不代表预测或保证             |
| 教学案例   | 一键载入三套完全合成案例并完成分析、诊断和模拟           | 不含真实个人、企业或运单数据           |
| 报告与导出 | 预览并导出 Markdown、自包含 HTML 和安全 CSV              | PDF 尚未达到发布准入；敏感字段默认排除 |
| 本地清理   | 查看并删除数据集及可识别的关联文件、方案和报告任务       | 删除不可恢复，需要二次确认             |

## 适用与不适用场景

适合：

- 物流管理课程、作业、案例教学和指标复算；
- 中小商家对导出订单、仓库和物流轨迹进行离线诊断；
- 学习数据质量、分母、分位数、异常规则和情景模拟；
- 需要可审查、可复现分析流程的开源实践。

不适合：

- 完整 WMS、TMS、ERP、库存或财务系统；
- 实时车辆定位、快递下单、付费轨迹接口或自动调度；
- 多租户计费、生产级权限体系或云端长期托管；
- 用大模型替代指标公式、规则证据或经营因果验证；
- 把情景模拟当作真实预测、承诺或投资/经营保证。

## 10 分钟快速体验

### 1. 准备环境

- Node.js `>=22.12 <25`
- npm `>=10`
- Python `>=3.11`
- Docker Compose 可选

Windows PowerShell：

```powershell
npm.cmd ci
python -m venv apps/api/.venv
.\apps\api\.venv\Scripts\Activate.ps1
python -m pip install -r apps/api/requirements-dev.txt
```

macOS/Linux：

```bash
npm ci
python -m venv apps/api/.venv
source apps/api/.venv/bin/activate
python -m pip install -r apps/api/requirements-dev.txt
```

### 2. 启动本地开发

激活虚拟环境后：

```powershell
npm run dev
```

打开：

- Web：<http://127.0.0.1:5173>
- API 健康检查：<http://127.0.0.1:8000/health>
- OpenAPI：<http://127.0.0.1:8000/docs>

### 3. 载入合成案例

打开 <http://127.0.0.1:5173/cases>，选择一个案例并确认替换当前分析上下文。推荐顺序：

1. 正常运营：学习指标和字段；
2. 促销爆单：观察仓库拥堵和仓内时长恶化；
3. 承运商异常：追溯揽收、干线和末端长尾。

也可以用命令重新生成并验证静态案例：

```powershell
npm run generate:cases
npm run demo:cases
```

只复验 What-if 三类核心方案时可运行真实演示脚本：

```powershell
python scripts/demo_simulation.py
```

### 4. 浏览完整路径

依次打开“分析总览 → 异常诊断 → 方案模拟 → 分析报告”。查看指标解释、筛选承运商、进入异常订单时间线，复制方案并生成“快速阅读版”HTML 报告。

### 5. 运行测试

```powershell
npm run release:check
```

该命令检查格式、静态规则、类型、测试、构建、依赖漏洞、文档链接、发布文件和依赖许可证。性能专项单独运行：

```powershell
python scripts/performance_benchmark.py
```

### 6. 清理数据

优先使用“设置 → 本地数据与隐私”，逐个确认删除。API 运行时也可以执行：

```powershell
$datasets = (Invoke-RestMethod http://127.0.0.1:8000/api/datasets).datasets
$datasets | ForEach-Object {
  Invoke-RestMethod -Method Delete -Uri "http://127.0.0.1:8000/api/datasets/$($_.dataset_id)"
}
```

删除不可恢复。该接口会清理分析行、可识别导入文件、关联方案和报告任务。

## Docker Compose

在已安装 Docker 的环境：

```powershell
docker compose config --quiet
docker compose up --build -d
docker compose ps
```

打开 <http://127.0.0.1:5173>。查看日志与停止：

```powershell
docker compose logs --no-color
docker compose down
```

若确定要同时删除全部持久数据卷：

```powershell
docker compose down --volumes
```

最后一个命令不可恢复。GitHub Actions 的独立 Docker smoke job 会实际构建、启动、检查健康状态并清理数据卷；本机结果以当前发布验收记录为准。

## Cloudflare 在线预览

在线预览：<https://fulfilllens-cn.esthertreu3724.workers.dev>

在线预览仅验证 React 页面壳、同源健康/版本接口和 Workers AI 固定合成探针。它不会接收订单、仓库事件或物流轨迹，导入、指标、诊断、模拟和报告仍需本地或 Docker 完整版。部署配置在 `wrangler.jsonc`，AI 通过 `AI` binding 调用，Account ID 和 API Token 不进入浏览器或仓库。

```powershell
npm.cmd run build:cloudflare
npm.cmd run test:cloudflare
npm.cmd run deploy:cloudflare
```

部署命令需要在进程环境中提供 Cloudflare 发布凭据；不得把真实令牌写入 `.env`、Wrangler 配置或 Git。能力边界、回滚和验证方法见[Cloudflare 部署说明](docs/CLOUDFLARE_DEPLOYMENT.md)。

## 本地开发

无需 `.env` 即可使用安全默认值。确需覆盖配置时：

```powershell
Copy-Item apps/api/.env.example apps/api/.env
Copy-Item apps/web/.env.example apps/web/.env
```

`.env` 已被忽略，不得提交真实密钥。分别启动：

```powershell
npm run dev:web
npm run dev:api
```

主要命令：

| 命令                     | 作用                                       |
| ------------------------ | ------------------------------------------ |
| `npm run format`         | 格式化前端、Python 和发布文档              |
| `npm run format:check`   | 检查格式但不修改                           |
| `npm run lint`           | ESLint 与 Ruff                             |
| `npm run typecheck`      | TypeScript 与 mypy                         |
| `npm run test`           | Vitest、pytest 和契约测试                  |
| `npm run build`          | 生产构建 Web                               |
| `npm run smoke`          | 临时启动 API/Web 并检查核心路由            |
| `npm run docs:check`     | 检查文档链接、章节、泄露与发布文件         |
| `npm run licenses:check` | 检查依赖许可证阻断项                       |
| `npm run audit`          | npm 与 Python 已知漏洞审计                 |
| `npm run release:check`  | 发布前本地完整质量链，不含 Docker/性能专项 |

更多问题见[故障排查](docs/TROUBLESHOOTING.md)和[常见问题](docs/FAQ.md)。

## 导入格式与数据规则

支持三类数据：

- `orders`：一行一个订单；
- `warehouse_events`：一行一个仓库节点事件；
- `tracking_events`：一行一个物流轨迹事件。

支持 CSV 与 XLSX。CSV 支持 UTF-8、UTF-8 BOM、GBK/GB18030 等常见中文编码；无法可靠识别时要求用户确认。时间统一按带时区 ISO 8601；无时区数据必须指定默认时区。

模板位于 `data/templates/`，机器可读 Schema 位于 `data/schemas/`。完整字段见[数据字典](docs/DATA_DICTIONARY.md)，状态见[状态体系](docs/STATUS_TAXONOMY.md)，导入限制见[导入规范](docs/IMPORTING.md)。

默认文件保护包括扩展名/MIME/大小、XLSX 解压规模、行列数、长文本、文件名和路径检查；不执行 Excel 宏和公式。导出 CSV 对 `= + - @` 前缀安全转义。

## 技术架构

```text
React + TypeScript + Vite + Ant Design + ECharts
                       │ /api、/health
                       ▼
FastAPI + Pydantic ── 领域服务与透明规则
        │                    │
        ├─ DuckDB：订单/事件分析数据
        ├─ SQLite：数据集与方案控制元数据
        └─ 本地临时文件：导入/报告任务（可清理）
```

- `apps/web`：响应式中文 Web 与 API client；
- `apps/api`：导入、指标、诊断、模拟、案例、报告和清理 API；
- `data`：Schema、模板、规则和完全合成案例；
- `docs`：产品、口径、架构、风险、教学和发布资料；
- `tests`：后端、前端、契约、端到端、安全和性能验证。

完整说明见[架构文档](docs/ARCHITECTURE.md)和[ADR](docs/adr/README.md)。Cloudflare 在线预览已建立独立 Worker 适配层；当前 FastAPI/DuckDB/SQLite 后端仍不能零修改部署，见[部署与可行性说明](docs/CLOUDFLARE_DEPLOYMENT.md)。

## 项目状态与已知限制

阶段 0–11 已完成可在当前环境执行的内容；阶段 12 将进行最终全量验收。当前证据：

- 前端 22 项测试、后端与契约 218 项测试；
- 1 万/5 万订单性能基准；
- 8 个路由 × 360/768/1440 Chromium + axe 检查；
- npm/Python 漏洞审计和敏感信息扫描。

仍需发布前确认：

- Docker 实机构建、健康检查和持久卷清理；
- Firefox/Safari；
- PDF 中文字体、分页和长表；
- 远程仓库私密安全报告入口；
- 干净克隆后的阶段 12 完整验收。

报告和基准是特定代码、数据和机器条件下的证据，不是对所有硬件或业务数据的保证。

## 路线图

- 阶段 0–4：仓库、产品/数据契约、工程骨架、导入与指标；
- 阶段 5–9：仪表盘、诊断、模拟、案例和报告；
- 阶段 10：安全、性能、回归、移动端和可访问性；
- 阶段 11：中英文开源文档、许可证、治理模板和 RC 资料；
- 阶段 12：干净环境全量验收与 v1.0 发布判断。

详见[路线图](docs/ROADMAP.md)和[v1.0.0-rc.1 发布说明草案](docs/releases/v1.0.0-rc.1.md)。

## 隐私、安全与免责声明

- 示例、教材和报告样例全部由固定种子程序生成；
- 姓名、手机号、详细地址、身份证等只提示风险，不写入日志；
- 报告默认排除敏感字段，订单标识需要二次确认；
- Workers AI 默认关闭，不读取导入数据，也不参与指标或规则；
- 真实凭据只允许放在被忽略的本机 `.env`，曾出现在聊天或日志中的凭据应立即轮换；
- 使用者负责确认字段语义、时区、数量单位、承诺口径、覆盖率和阈值。

本软件按 MIT 许可证“原样”提供，不保证无错误、适合特定用途、经营效果或数据结论。异常诊断是规则判断，可能原因需要进一步核查；What-if 结果是情景估算，不代表预测、因果证明或服务保证。

安全问题请阅读 [SECURITY.md](SECURITY.md)。

## 文档

- [产品需求](docs/PRD.md)
- [指标口径](docs/METRICS.md)
- [数据字典](docs/DATA_DICTIONARY.md)
- [状态体系](docs/STATUS_TAXONOMY.md)
- [导入规范](docs/IMPORTING.md)
- [诊断规范](docs/DIAGNOSTICS.md)
- [模拟说明](docs/SIMULATION.md)
- [案例教材](docs/case-studies/README.md)
- [报告规范](docs/REPORTING.md)
- [架构与 ADR](docs/ARCHITECTURE.md)
- [FAQ](docs/FAQ.md)
- [故障排查](docs/TROUBLESHOOTING.md)
- [依赖许可证](docs/DEPENDENCY_LICENSES.md)
- [完整文档索引](docs/README.md)

## 贡献

欢迎错误修复、测试、字段别名、状态映射、教学案例和文档改进。提交前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)和[社区行为准则](CODE_OF_CONDUCT.md)。

Issue 和 PR 只能附完全合成且已脱敏的数据。指标、规则、Schema、模拟或新依赖变化必须说明口径、风险、许可证和验收证据。

## 许可证

FulfillLens CN 使用 [MIT License](LICENSE)。第三方依赖保留各自许可证，审查结论和 MPL/CC/Apache 注意事项见[依赖许可证审查](docs/DEPENDENCY_LICENSES.md)。

引用教学或研究使用时可使用 [CITATION.cff](CITATION.cff)。
