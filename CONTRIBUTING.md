# 为 FulfillLens 贡献

感谢你愿意改进 FulfillLens。项目服务物流教学与中小商家，本地优先、可解释、可复算和隐私安全比功能数量更重要。

## 开始之前

- 阅读 [产品需求](docs/PRD.md)、[指标口径](docs/METRICS.md)、[数据字典](docs/DATA_DICTIONARY.md)和[架构说明](docs/ARCHITECTURE.md)。
- 搜索已有 Issue，避免重复工作。较大的功能或指标口径变化应先提交 Feature Issue。
- 安全问题不要创建公开 Issue，请按 [安全政策](SECURITY.md)私密报告。
- 不得在 Issue、日志、截图、测试或 PR 中提交真实订单、姓名、手机号、地址、身份证、密钥或企业内部数据。

## 开发环境

要求 Node.js `>=22.12 <25`、npm `>=10`、Python `>=3.11`。完整步骤见 [README](README.md#本地开发)。

```powershell
npm ci
python -m venv apps/api/.venv
.\apps\api\.venv\Scripts\Activate.ps1
python -m pip install -r apps/api/requirements-dev.txt
npm run dev
```

macOS/Linux 将激活命令替换为：

```bash
source apps/api/.venv/bin/activate
```

## 选择工作范围

适合直接提交的小改动包括文案、无争议的错误修复、测试补充和文档链接修复。以下变更应先讨论：

- 新指标、指标公式、分母、分位数或取消/退回策略；
- 新诊断规则、严重度、阈值或“可能原因”措辞；
- 模拟变换、随机过程或数据覆盖率策略；
- 数据 Schema、标准状态、隐私等级或默认保留期限；
- 新运行时、数据库、云服务、AI 数据路径或许可证策略。

第一版不接受完整 WMS/TMS/ERP、实时车辆定位、付费快递接口、多租户计费和不可解释的模型诊断。

## 分支、提交与 PR

1. 从最新 `main` 创建范围单一的分支，如 `fix/csv-encoding-report`。
2. 保留现有技术栈和目录；不要为小改动重写模块。
3. 使用清晰的提交信息，例如 `fix: preserve unmapped tracking status`。
4. PR 必须说明问题、方案、风险、人工验收和实际运行的命令。
5. 如果修改界面，附 360px 与桌面验证证据；如果修改数据逻辑，附可人工复算的合成样例。

## 代码与数据要求

- 用户界面和默认文档使用简体中文；代码标识符使用清晰英文，并为未来 i18n 保留边界。
- 时间使用带时区 ISO 8601；无时区导入必须要求默认时区。
- 未知状态保留原值并标记 `unmapped`，不得静默删除。
- 不可计算订单不能作为成功或失败进入指标分母。
- 模拟必须在订单/事件层应用变换后重算，显著标注为情景估算。
- 示例和测试数据必须完全合成；敏感识别测试可使用明显的合成占位值，但不得复用真实信息。
- 新依赖必须说明必要性、许可证、体积、安全和替代方案。AGPL/GPL/LGPL 等依赖需要维护者先完成兼容性评审。

## 提交前检查

激活 Python 虚拟环境后运行：

```powershell
npm run format
npm run release:check
python scripts/performance_benchmark.py  # 仅在性能路径变化时必需
```

Docker 相关变更还必须在有 Docker 的环境运行：

```powershell
docker compose config --quiet
docker compose up --build -d
docker compose ps
docker compose down --volumes
```

不得删除测试、降低断言、跳过失败检查或用静态结果绕过真实逻辑。

## 文档一致性

- 指标、字段、状态和 API 变化必须同步修改对应文档与机器可读契约。
- 中文 README 与 `README_EN.md` 必须保持能力、限制、命令和版本一致。
- 不要引用尚未提交的截图；发布素材状态记录在 [截图与 GIF 清单](docs/SCREENSHOTS.md)。
- 运行 `npm run docs:check` 验证本地链接、必需章节、发布文件和常见泄露风险。

## 评审标准

维护者会检查用户价值、正确性、可解释性、隐私、安全、性能、可访问性、向后兼容和许可证。贡献被合并不代表其中的模拟结果或业务建议获得任何效果保证。
