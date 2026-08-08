# 空白导入模板

本目录提供仅含表头的 UTF-8 CSV 模板，不包含真实数据、个人信息或伪装成真实记录的示例：

- `orders.csv`
- `warehouse_events.csv`
- `tracking_events.csv`

使用时须遵守：

- 时间填写为带时区的 ISO 8601，例如 `2026-07-01T08:00:00+08:00`；
- 原始数据没有时区时，导入流程必须要求用户指定默认时区；
- `event_code`、`order_status` 使用 [`STATUS_TAXONOMY.md`](../../docs/STATUS_TAXONOMY.md) 中的英文标准代码；
- 无法映射的状态使用 `unmapped`，同时在原始状态字段保留原值；
- 字段释义、敏感等级和校验规则见 [`DATA_DICTIONARY.md`](../../docs/DATA_DICTIONARY.md)；
- 为防止表格公式注入，后续导出实现必须安全处理以 `=`, `+`, `-`, `@` 开头的文本。
