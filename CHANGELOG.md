# 变更记录

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，并使用 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Planned

- 收集 RC 使用反馈并修复可复现回归；
- 评估 Firefox/Safari 兼容性和可复现 PDF 中文渲染；
- 评估 Cloudflare 上的完整后端迁移方案，同时保持本地优先和可解释数据边界。

## [1.0.0-rc.2] - 2026-08-09

### Fixed

- 修复生产分块导致 Ant Design 初始化异常和真实浏览器白屏；
- 修复设置页无数据状态文字对比度不足；
- 修复 Docker API 镜像缺少合成案例资产，恢复一键载入；
- 补齐 Docker API 镜像的诊断规则运行期资产，恢复容器内透明诊断；
- 案例载入前置校验资产，并在数据集注册中途失败时回滚，避免孤儿数据。
- 修复 Cloudflare 在线演示 P50/P90 未使用 Type-7，以及 What-if 直接调整汇总指标的问题；在线模拟现从合成订单/节点副本变换后复算并校验参数。
- 修复在线报告跨 Worker 实例恢复时丢失筛选条件，以及合成节点时间线可能超出订单生命周期的问题。

### Changed

- GitHub Actions 官方 `checkout`、`setup-node`、`setup-python` 升级到 v7，消除 Node.js 20 运行时弃用警告；
- Docker smoke 增加真实 Chrome、360/768/1440 三视口和 axe/WCAG 审计；
- Cloudflare 从静态受限预览扩展为只处理公开合成案例的同源分析演示，仍拒绝真实文件和持久业务数据；
- 完成 Windows 重启后的本机 Docker、三案例、金标准、5 万订单性能和数据清理验收；
- 发布结论为可发布 `v1.0.0-rc.2` 预发布版本，正式 `v1.0.0` 仍需处理已知限制。

## [1.0.0-rc.1] - 2026-08-08

> 发布候选资料已准备，但尚未创建 GitHub Release、标签或远程发布。

### Added

- CSV/XLSX 七步导入、字段映射、质量报告、状态标准化和本地数据清理；
- OT、IF、OTIF、时效、节点停留、异常、取消、退回和覆盖率指标引擎；
- 趋势、分布、节点瓶颈、维度对比、订单证据和安全 CSV 导出；
- 八类透明诊断规则、证据追溯、严重度、帕累托和订单时间线；
- 四类订单/事件层 What-if 变换、敏感性分析和可复现指纹；
- 三套固定种子合成教学案例；
- Markdown、自包含 HTML 和安全 CSV 报告；
- 中文首次使用说明、移动端与可访问性加固；
- 中英文开源文档、社区治理模板、依赖许可与发布检查。

### Security

- 文件类型、MIME、解压炸弹、路径、公式注入、XSS、CORS、错误堆栈和敏感日志保护；
- 默认不导出敏感字段，Workers AI 默认关闭且不接触导入数据；
- API 安全响应头、非特权容器和受限 Compose 权限。
- 将构建链传递依赖 `brace-expansion` 与 `nanoid` 更新到修复已知拒绝服务问题的补丁版本。

### Performance

- Pandas 到 DuckDB 列式批量写入；
- 模拟按订单和事件建立索引，移除 O(n²) 扫描；
- 报告复用筛选结果并延迟读取订单样例。

### Known limitations

- Docker、Firefox、Safari 和 PDF 尚未完成正式发布验收；
- 当前后端不能不经迁移直接部署到 Cloudflare Workers；
- 诊断是透明规则判断，模拟是基于历史数据与简化假设的情景估算。
