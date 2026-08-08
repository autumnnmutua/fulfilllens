# 机器可读数据契约

本目录使用 JSON Schema Draft 2020-12 描述 FulfillLens CN 阶段 1 的三类标准化行记录：

- `order.schema.json`：订单表；
- `warehouse_event.schema.json`：仓库事件表；
- `tracking_event.schema.json`：物流轨迹表；
- `status_codes.schema.json`：三个领域共享的标准状态枚举。

## 使用约定

- Schema 校验对象是完成字段映射后的单行 JSON 记录，不直接描述原始 CSV/XLSX 文件。
- 所有时间必须是带 `Z` 或数值偏移的 ISO 8601 字符串；无时区原始值须由用户先指定默认时区。
- 可选字段可以省略或传入 `null`；必填字段缺失、类型错误、未知标准状态和未声明字段均校验失败。
- `unmapped` 是合法标准状态，但 `raw_status` 或 `raw_order_status` 仍必须保留非空原始值。
- JSON Schema 负责结构和基础类型；跨表外键、时间先后、重复冲突、数量单位一致性等语义规则由导入验证层执行。
- `$id` 只作为稳定的离线标识，不要求联网访问。

验证命令见 [`tests/README.md`](../../tests/README.md)。
