# ADR 0008：本地运行与 Cloudflare 云模式边界

- 状态：Accepted
- 日期：2026-08-01

## 背景

项目以本地优先为产品承诺，但用户计划后期部署到 Cloudflare，并希望使用 Workers AI。当前服务依赖 FastAPI、DuckDB、SQLite 和本机临时文件；Cloudflare Workers 的文件系统不持久，Python Workers 仍为 beta，AI 调用也会改变数据边界。

## 决定

1. 保留当前本地模式及其“数据默认不离开设备”能力；
2. Cloudflare 部署定义为独立云模式，不把本机文件路径、SQLite 或 DuckDB 文件直接当作 Worker 持久层；
3. 云模式预期使用静态资源 + Worker API，D1 承接控制元数据，R2 承接对象；最终分析执行位置在 PoC 后决定；
4. 部署内调用 Workers AI 优先使用 `AI` binding；REST Token 仅用于本机开发/探针，绝不进入浏览器；
5. AI 是可选解释层，不进入指标公式、诊断规则、严重度、模拟变换或对账；
6. 云模式必须显式告知上传、保留、删除和 AI 数据访问范围。

## 理由

- 避免把临时 Worker 文件误认为持久数据；
- 保留本地隐私价值，同时允许后续提供低运维的云体验；
- 将确定性分析与概率模型隔离，保证结果可复算；
- 使用 binding 减少长期 Token 暴露面。

## 后果

- 部署不是单纯增加 Wrangler 配置，而是需要存储和任务生命周期迁移；
- 本地与云模式必须共享 Schema、指标和规则版本测试；
- 云模式产生额外隐私、费用、权限和删除义务；
- Python Worker 与 TypeScript Worker 的最终选择仍需依赖兼容/性能 PoC。

## 替代方案

- 原样部署 FastAPI 容器到其他平台，再用 Cloudflare 代理：兼容性更高，但不满足“全部运行在 Cloudflare”的目标；
- 全部改写 TypeScript：Worker 兼容性好，但会复制/迁移大量已测试 Python 数据逻辑；
- 只部署静态前端、要求用户本机启动 API：最符合本地优先，但不是独立在线网页体验。

## 复审条件

- Python Workers 退出 beta或项目依赖兼容性显著变化；
- 完成 1 万/5 万订单 PoC；
- 引入用户账号、多设备同步或长期云存储；
- Workers AI 被授权访问任何真实派生数据。
