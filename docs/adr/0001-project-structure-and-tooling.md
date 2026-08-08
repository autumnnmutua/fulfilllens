# ADR-0001：项目结构与基础工具链

- 状态：Accepted
- 日期：2026-07-29
- 决策者：FulfillLens CN 技术负责人

## 背景

FulfillLens CN 需要同时维护前端、API、可复用数据逻辑、合成数据、文档和跨模块测试。主要贡献者可能使用 Windows，首版又必须保持本地优先、低门槛和可审查，因此不适合在项目起点引入微服务、复杂构建编排或机器专用工具。

阶段 0 本机检测到 Node.js 24.16.0、npm 11.13.0、Python 3.13.14、pip 26.1.2 和 Git 2.54.0；未检测到 Docker、Yarn、uv 或 Poetry。检测到的 pnpm 位于 Codex 内置运行时路径，不能假设普通贡献者拥有相同位置。

## 决定

1. 使用单仓库 monorepo，保留 `apps/web`、`apps/api`、`packages`、`data`、`docs` 和 `tests`。
2. 前端和 JavaScript/TypeScript 共享包采用 npm workspaces。根 `package.json`、真实 scripts 和 lockfile 在阶段 2 随工程骨架一起建立并验证；阶段 0 不创建空脚本伪装可运行能力。
3. Python 后端采用标准库 `venv`，虚拟环境固定在 `apps/api/.venv`，依赖声明和锁定方式在阶段 2 根据 FastAPI、Pandas、DuckDB 等实际兼容性确定。
4. 不引入 Nx、Turborepo、Poetry、uv、微服务或远程数据库作为阶段 0 前置条件。
5. 代码与文档使用 UTF-8；仓库文本默认 LF；Windows 脚本保留 CRLF；通过 `.editorconfig` 和 `.gitattributes` 明确约束。
6. 不在仓库中保存真实导入数据、个人信息、本地数据库、上传、日志和导出结果。
7. 当前不锁定 Node.js/Python 最终支持版本。阶段 2 必须用真实安装、测试和构建结果确定 engines、Python 版本与 CI 矩阵。

## 理由

- npm 和 `venv` 均随当前主流运行时提供，贡献门槛低；
- 单仓库便于前后端契约、指标公式和测试同步审查；
- 延后依赖锁定可以避免在没有代码与依赖的情况下制造无意义 lockfile；
- 不依赖 Codex 专用路径，降低换机器、换账号和 CI 环境的风险；
- 明确数据边界符合本地优先和开源隐私要求。

## 后果

正面影响：

- 结构简单，阶段成果和 Git diff 容易审查；
- 前后端与共享模块可在同一提交中保持契约一致；
- Windows 用户可以使用系统 Node.js、npm、Python 和 Git。

代价与风险：

- 阶段 2 仍需验证 Node.js 24/Python 3.13 的第三方依赖支持；
- Docker 未安装，当前不能验证容器路径；
- 不使用高级任务编排工具意味着早期脚本由根 npm scripts 和文档协调。

## 备选方案

- pnpm workspaces：性能和磁盘效率较好，但当前检测到的 pnpm 来自 Codex 专用路径，不作为仓库基线。
- Poetry 或 uv：可提供更强的 Python 依赖体验，但当前机器未安装，MVP 暂无必要增加前置工具。
- 多仓库或微服务：会增加接口同步、发布和贡献成本，不符合当前 MVP。

## 复审条件

出现以下任一情况时新增 ADR 复审：

- 阶段 2 的依赖无法稳定支持选定 Node.js/Python 版本；
- 共享包构建或测试显著需要任务缓存与拓扑编排；
- 数据规模证明单进程本地架构无法满足已记录的性能预算；
- 开源贡献流程显示现有工具链造成持续、可量化的阻碍。
