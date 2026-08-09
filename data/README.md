# 数据目录

此目录仅用于可公开的机器可读 Schema、空白导入模板和完全合成的示例数据。

- [`schemas/`](schemas/README.md)：标准化行记录的 JSON Schema；
- [`rules/`](rules/diagnostic_rules.v1.json)：阶段 6 版本化透明诊断默认配置；
- [`templates/`](templates/README.md)：仅含表头的 UTF-8 CSV 导入模板；
- [`cases/`](cases/)：阶段 8 固定种子生成的三套 CSV、XLSX 和 metadata 教学案例。
- [`samples/`](samples/)：两份全新合成的非标准 CSV/XLSX 兼容性样例和带 SHA-256 的目录清单；用于验证自动转换，不替代三套教学案例。
- [`examples/`](examples/)：阶段 9 使用促销爆单合成案例实际生成的 Markdown、HTML 和安全 CSV 报告。

约束：

- 不提交真实订单或个人信息；
- 本地导入、临时生成和用户导出内容分别放入已忽略的 `data/local/`、`data/generated/`、`data/exports/`；`examples/` 只允许可复现的合成验收成品；
- 合成数据必须记录生成器版本、随机种子、场景和预期现象；
- 兼容性样例必须通过真实解析、Schema、导入和指标回归，且目录摘要与文件内容一致；
- CSV/XLSX 模板、编码、时区和单位由阶段 1 的数据字典统一定义；
- 当前 Schema 是导入映射后的行级契约，跨表和业务语义校验由后续导入层实现。
