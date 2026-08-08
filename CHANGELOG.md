# 变更记录

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，并使用 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Planned

- 阶段 12 干净环境全量验收和最终发布判断；
- Docker 实机构建、Firefox/Safari 兼容性和 PDF 中文渲染准入；
- Cloudflare 云模式 PoC，不改变当前本地优先数据边界。

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
