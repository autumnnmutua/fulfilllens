# FulfillLens 指标口径

- 文档状态：阶段 4 已实现
- 定义版本：metrics-v1.1.0
- 更新日期：2026-07-29

## 1. 统一计算约定

### 1.1 订单粒度

- 主要结果指标按唯一 `order_id` 计算，一张订单在标准订单表中只能有一行；
- 第一版允许源数据存在拆单或分批交付，但导入层必须先聚合到订单粒度：
  - `delivered_quantity` 为各有效交付的累计数量；
  - `actual_delivery_time` 为该订单最后一次有效交付时间；对于足量订单，即达到足量状态的完成时间；
  - 不做 SKU/订单行级 IF，也不在不同数量单位间自动换算；
- `returned` 订单若曾完成交付且字段充分，可进入 OT/IF/OTIF；`cancelled` 订单不进入这些成功率分母；
- 尚未完成的 `created`、`confirmed`、`processing`、`shipped` 订单记为待完成，不混入已完成成功率。
- 部分交付：完成订单中 `delivered_quantity < ordered_quantity` 时 IF/OTIF 为假，OT 仍按时间独立判定，并触发基线异常规则；
- 拒收：第一版没有独立订单状态，不根据原始中文文本猜测；只有经状态映射确认的物流 `delivery_failed`、`return_initiated` 或 `returned` 事件才进入异常证据；
- 拆单/多运单：订单结果仅使用导入前聚合的订单行；物流节点按 `shipment_id` 分别配对，不把多个运单的起止事件交叉拼接。

### 1.2 时间

- 标准时间字段必须是带 `Z` 或 UTC 偏移的 ISO 8601/RFC 3339 字符串；
- 导入无时区时间时，用户必须指定默认 IANA 时区，例如 `Asia/Shanghai`；
- 比较和相减前转换为 UTC；展示时可转换回用户选择的时区；
- 夏令时歧义和不存在的本地时间必须提示用户，不得静默猜测；
- 负时长、无法解析时间和明显倒序事件标记为数据质量错误，不进入时长分布。

### 1.3 空值与不可计算

- 空单元格在标准化后表示字段缺失，不使用 `0`、当前时间或成功状态填充；
- 缺少某指标必要字段时，该订单对该指标标记为 `not_computable`；
- 待完成订单标记为 `pending`，与数据不足导致的 `not_computable` 分开；
- 指标必须同时返回不可计算数、待完成数和数据覆盖率。

### 1.4 重复与冲突

- 主键和全部标准字段完全相同的重复行只保留一行，并记录精确重复数量；
- 同一 `order_id` 存在字段冲突时，订单标记为 `duplicate_conflict`，在解决前不进入订单级指标；
- 事件表同一事件主键冲突时同样隔离；
- 不同事件主键但状态和时间相同的记录可能是业务重复扫描，不能仅凭相似就删除，应由规则标记。
- 事件先在原导入顺序中检查倒序，再统一转 UTC 并按 `event_time`、`sequence_number`、稳定导入顺序和事件主键排序；
- 同一节点多次出现时，第一版只取第一条完整、非负的有效区间；额外循环保留 `multiple_cycles` 警告；
- 结束事件早于开始、孤立事件、冲突事件和早于订单创建的事件不进入节点时长，但必须保留数据警告。

### 1.5 数量与单位

- `ordered_quantity` 必须大于 0；
- `delivered_quantity` 缺失时 IF/OTIF 不可计算，0 是合法值；
- 比较数量前要求 `quantity_unit` 一致；
- 第一版不自动换算箱、件、千克等单位；需要换算时必须在导入前或映射配置中提供明确规则并版本化。

### 1.6 百分比与舍入

- 内部计算保留原始精度；
- API 建议返回 0–1 的原始比例，界面按百分比显示；
- 展示默认保留 1 位小数，报告可配置，但分子和分母必须同时展示；
- 不在聚合前对订单值或时长提前舍入。

### 1.7 数据覆盖率

```text
data_coverage = computable_count / eligible_count
```

- `eligible_count`：按业务状态和指标范围本应可参与的订单数；
- `computable_count`：必要字段合法、重复冲突已解决且实际进入公式的订单数；
- 如果 `eligible_count = 0`，覆盖率和值均返回空，并显示“无符合条件样本”；
- 低覆盖不得给出看似确定的结论。

## 2. 统一合成示例

以下订单仅用于解释公式：

| order_id    | created_at                | promised_delivery_time    | actual_delivery_time      | ordered_quantity | delivered_quantity | order_status |
| ----------- | ------------------------- | ------------------------- | ------------------------- | ---------------: | -----------------: | ------------ |
| ORD-SYN-001 | 2026-07-01T08:00:00+08:00 | 2026-07-03T18:00:00+08:00 | 2026-07-03T12:00:00+08:00 |                2 |                  2 | delivered    |
| ORD-SYN-002 | 2026-07-01T09:00:00+08:00 | 2026-07-03T18:00:00+08:00 | 2026-07-04T10:00:00+08:00 |                1 |                  1 | delivered    |
| ORD-SYN-003 | 2026-07-01T10:00:00+08:00 | 2026-07-03T18:00:00+08:00 | 2026-07-03T15:00:00+08:00 |                3 |                  2 | delivered    |
| ORD-SYN-004 | 2026-07-01T11:00:00+08:00 | 2026-07-03T18:00:00+08:00 | 缺失                      |                1 |                  0 | cancelled    |

前三单的总履约时长分别为 52、73、53 小时。

## 3. OT（On Time，按时交付率）

- **业务含义**：已完成交付订单中，实际交付时间不晚于承诺交付时间的比例；
- **订单判定**：

```text
is_ot = actual_delivery_time <= promised_delivery_time
```

- **汇总公式**：

```text
OT = count(is_ot = true) / count(OT 可计算订单)
```

- **字段依赖**：`order_id`、`order_status`、`promised_delivery_time`、`actual_delivery_time`；
- **空值处理**：任一时间缺失则 OT 不可计算，不记为按时或不按时；
- **重复处理**：冲突重复订单排除并计入覆盖警告；
- **异常处理**：时间非法、倒序或状态尚未完成时不进入已完成分母；`cancelled` 排除，`returned` 在有有效交付记录时可参与；
- **可配置项**：MVP 默认零容差，严格使用上述公式；未来如增加容差，必须返回 `on_time_tolerance_seconds` 和新口径版本；
- **例子**：示例中 ORD-SYN-001、ORD-SYN-003 按时，ORD-SYN-002 超时，OT = `2 / 3 = 66.7%`。

## 4. IF（In Full，足量交付率）

- **业务含义**：已完成交付订单中，累计有效交付数量达到订购数量的比例；
- **订单判定**：

```text
is_if = delivered_quantity >= ordered_quantity
```

- **汇总公式**：

```text
IF = count(is_if = true) / count(IF 可计算订单)
```

- **字段依赖**：`order_id`、`order_status`、`ordered_quantity`、`delivered_quantity`、`quantity_unit`；
- **空值处理**：任一数量或单位缺失则不可计算；
- **重复处理**：不得把重复订单行再次相加；拆单数据必须先按订单和统一单位汇总；
- **异常处理**：`ordered_quantity <= 0`、负交付量或单位不一致为错误；超额交付仍判定 IF 为真，但另发数量异常警告；
- **可配置项**：MVP 数量容差为 0，不自动单位换算；拆单聚合规则必须记录在映射配置中；
- **例子**：ORD-SYN-001、ORD-SYN-002 足量，ORD-SYN-003 不足量，IF = `2 / 3 = 66.7%`。

## 5. OTIF（On Time In Full，按时足量交付率）

- **业务含义**：同时满足按时和足量，是 MVP 的主要履约结果指标；
- **订单判定**：

```text
is_otif = is_ot AND is_if
```

- **汇总公式**：

```text
OTIF = count(is_ot = true AND is_if = true)
       / count(OT 与 IF 均可计算的订单)
```

- **字段依赖**：OT 和 IF 的全部字段；
- **空值处理**：OT 或 IF 任一不可计算，则 OTIF 不可计算；
- **重复处理**：沿用订单冲突重复策略；
- **异常处理**：不得用单独 OT 和 IF 的汇总百分比相乘；必须在订单粒度组合；
- **可配置项**：继承 OT 容差和拆单聚合版本，响应中同时返回两者；
- **例子**：只有 ORD-SYN-001 同时满足，OTIF = `1 / 3 = 33.3%`。

## 6. 订单履约总时长

- **业务含义**：从订单创建到实际交付完成的端到端耗时；
- **订单公式**：

```text
fulfillment_duration_hours =
  (actual_delivery_time - created_at) / 3600 seconds
```

- **字段依赖**：`order_id`、`order_status`、`created_at`、`actual_delivery_time`；
- **空值处理**：任一时间缺失则不可计算；
- **重复处理**：冲突订单排除；
- **异常处理**：负时长、非法时间、尚未完成和取消订单不进入完成时长分布；极端长时长保留并标记，不自动截尾；
- **可配置项**：展示单位可选小时或天，内部统一保存秒/小时精度；
- **例子**：ORD-SYN-001 总履约时长为 `52 小时`。

## 7. 节点停留时间

- **业务含义**：订单在仓库或运输流程某节点/区间的等待或处理耗时，用于定位瓶颈；
- **区间公式**：

```text
node_duration_hours =
  (end_event.event_time - start_event.event_time) / 3600 seconds
```

- **字段依赖**：
  - 通用：`order_id`、`event_time`、`event_code`；
  - 仓库：`event_id`、`warehouse_id`；
  - 物流：`tracking_event_id`、`shipment_id`、`carrier_id`、可选 `location_code`；
- **默认区间**：

| 区间代码        | 开始事件                | 结束事件                  | 含义                            |
| --------------- | ----------------------- | ------------------------- | ------------------------------- |
| order_to_pick   | `order_received`        | `picking_started`         | 接单后等待拣货                  |
| picking         | `picking_started`       | `picking_completed`       | 拣货处理                        |
| pick_to_qc      | `picking_completed`     | `quality_check_started`   | 等待复核                        |
| quality_check   | `quality_check_started` | `quality_check_completed` | 复核处理                        |
| packing         | `packing_started`       | `packing_completed`       | 打包处理                        |
| ready_to_pickup | `ready_to_ship`         | `carrier_picked_up`       | 出库/揽收等待                   |
| carrier_transit | `carrier_picked_up`     | `delivered`               | 承运运输总时长                  |
| hub_dwell       | `arrived_at_hub`        | `departed_hub`            | 同一 `location_code` 的枢纽停留 |

- **空值处理**：缺开始或结束事件时该区间不可计算，但保留缺失类型；
- **重复处理**：精确重复事件去重；多个不同事件构成循环时，MVP 选择按时间排序后的第一条完整有效区间，其余循环保留并发出 `multiple_cycles` 警告；
- **异常处理**：结束早于开始、跨订单/跨运单配对、枢纽地点不一致均判定无效；极端值保留并由规则判断；
- **可配置项**：区间定义和阈值可版本化，默认区间代码不允许用户无提示重定义；
- **例子**：`picking_started=09:00`，`picking_completed=10:30`，拣货时长为 `1.5 小时`。

## 8. 平均值

- **业务含义**：描述有效数值（通常为时长）的算术平均水平，易受长尾影响；
- **公式**：

```text
mean(x) = sum(valid_x) / count(valid_x)
```

- **字段依赖**：对应基础指标的有效订单/区间值；
- **空值处理**：缺失和不可计算值不进入公式，必须显示样本量和覆盖率；
- **重复处理**：基础订单/事件去重后再聚合；
- **异常处理**：合法极端值默认保留，不静默缩尾；同时展示中位数和 P90；
- **例子**：52、73、53 小时的平均值为 `(52+73+53)/3 = 59.3 小时`。

## 9. 中位数（P50）

- **业务含义**：一半有效样本不高于该值，较少受长尾影响；
- **公式**：对有效值升序排列，使用 Pandas/NumPy 线性分位数定义；P50 等同 0.5 分位数；
- **字段依赖**：对应基础指标的有效值；
- **空值/重复/异常处理**：同平均值；样本为空返回空，单样本返回该值；
- **可配置项**：MVP 不允许切换算法，避免不同页面或工具结果不一致；
- **例子**：52、53、73 小时的中位数为 `53 小时`。

## 10. P90

- **业务含义**：90% 有效样本不高于该值，用于观察长尾履约和节点耗时；
- **算法**：采用 Hyndman–Fan Type 7 / Pandas `quantile(0.9, interpolation="linear")`；
- **公式说明**：排序后位置为 `(n - 1) × 0.9`，位于两个样本之间时线性插值；
- **字段依赖**：对应基础指标的有效值；
- **空值/重复/异常处理**：同平均值；合法长尾保留；样本量小于 30 时显示小样本警告；
- **可配置项**：MVP 固定算法和 `q=0.9`，不由用户切换；
- **例子**：52、53、73 小时的位置为 `1.8`，P90 = `53 + 0.8 × (73-53) = 69 小时`。

## 11. 异常订单率

- **业务含义**：在非取消有效订单中，触发一条或多条阶段 4 基线透明规则的唯一订单比例；
- **公式**：

```text
anomaly_order_rate =
  count(distinct non-cancelled order_id with >= 1 baseline rule)
  / count(distinct structurally valid non-cancelled order_id)
```

- **规则版本**：`metric-baseline-rules-v1.0.0`；
- **基线规则**：订单为 `returned`；完成订单部分交付；仓库出现 `quality_check_failed`；物流出现 `delivery_failed`、`exception`、`return_initiated` 或 `returned`；
- **字段依赖**：`order_id`、订单状态与数量，以及相应仓库/物流事件代码；
- **空值处理**：订单结构有效且非取消即可进入分母；缺少可选事件数据时返回数据集选择与节点覆盖警告，不制造规则命中；
- **重复处理**：同一订单触发多条或重复规则只计一个异常订单；各规则命中数另行展示；
- **异常处理**：未知状态和数据质量警告不自动等同业务异常；订单明细返回命中原因和规则版本；
- **后续边界**：阶段 6 将扩展可配置诊断规则，不能无版本地改写本基线口径；
- **例子**：8 个有效订单中 1 个取消；其余 7 个中退回、部分交付和运输异常各命中 1 单，异常率 = `3 / 7 = 42.9%`。

## 12. 取消率

- **业务含义**：结构有效的唯一订单中，当前标准订单状态为取消的比例；
- **公式**：

```text
cancellation_rate =
  count(distinct order_id where order_status = "cancelled")
  / count(structurally valid distinct order_id)
```

- **字段依赖**：`order_id`、`order_status`；
- **空值处理**：状态缺失或 `unmapped` 的订单不计入分子，但保留在结构有效分母并显示状态覆盖警告；
- **重复处理**：冲突重复订单在解决前不进入分母；
- **异常处理**：取消与退回分开；`returned` 不算取消；
- **可配置项**：时间趋势默认按 `created_at` 分组，不按取消事件时间；改变时间锚点必须明确标注；
- **例子**：统一示例 4 个结构有效订单中 1 个取消，取消率 = `1 / 4 = 25%`。

### 12.1 退回率

```text
return_rate =
  count(distinct order_id where order_status = "returned")
  / count(structurally valid distinct order_id)
```

- 退回与取消分开；`delivery_failed` 只有在订单最终映射为 `returned` 时才进入退回率分子；
- 字段充分的退回订单仍可参与原交付 OT/IF/OTIF，以回答“交付时是否达标”；退回率回答后续是否退回；
- 状态为 `unmapped` 的订单留在结构有效分母，但降低状态覆盖率并产生警告。

### 12.2 核心履约数据覆盖率

```text
core_data_coverage =
  count(completed orders with computable OT, IF and fulfillment duration)
  / count(completed delivered or returned orders)
```

- 只面向完成候选订单，不因尚未完成或取消订单而人为降低覆盖；
- 该值用于判断核心履约结论是否有足够字段支撑，不替代每项指标自己的覆盖率；
- 分母为 0 时值和覆盖率均返回空。

## 13. 维度对比

- **业务含义**：按日期、仓库、承运商、目的地区或渠道比较同一指标，发现差异和需要核查的范围；
- **公式**：在每个维度组内重新计算原指标的订单级分子、分母和分布，不对组百分比做简单平均；
- **字段依赖**：
  - 日期：默认 `created_at`；
  - 仓库：`warehouse_id`；
  - 承运商：`carrier_id`；
  - 地区：`destination_region`；
  - 渠道：`sales_channel`；
  - 加上被比较指标的全部依赖字段；
- **空值处理**：维度缺失统一归入 `unknown`，不得静默删除；
- **重复处理**：订单级去重后分组；
- **异常处理**：每组返回样本量、覆盖率和警告；样本量小于 30 默认显示小样本提示；不得把相关差异表述为已证实因果；
- **可配置项**：筛选范围和维度可选，但口径与分母不随页面改变；
- **例子**：仓库 A 的 OTIF 为 `1/2=50%`，仓库 B 为 `0/1=0%`；两组样本均过小，只能作为核查线索。

## 14. 指标响应最小元数据

每个指标/API/导出至少包含：

```text
code
display_name
value
unit
numerator
denominator
eligible_count
computable_count
pending_count
not_computable_count
coverage
definition_version
warnings
```

分布指标还应返回 `quantile_method`；异常率返回 `rule_set_version`；模拟结果额外返回 `scenario_id` 和假设版本。

## 15. 指标—字段依赖矩阵

| 指标                | 订单表字段                                                                                           | 仓库事件字段                                           | 物流轨迹字段                                                                                  | 关键附加依赖               |
| ------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------- | -------------------------- |
| 订单总数/有效订单数 | `order_id` 及结构有效性                                                                              | —                                                      | —                                                                                             | 唯一订单、冲突隔离         |
| OT                  | `order_id`, `order_status`, `promised_delivery_time`, `actual_delivery_time`                         | —                                                      | —                                                                                             | 默认零容差、完成状态策略   |
| IF                  | `order_id`, `order_status`, `ordered_quantity`, `delivered_quantity`, `quantity_unit`                | 可选交付数量聚合来源                                   | 可选分批交付来源                                                                              | 拆单聚合版本、单位一致     |
| OTIF                | OT 与 IF 全部字段                                                                                    | 同 IF                                                  | 同 IF                                                                                         | 必须在订单粒度组合         |
| 订单履约总时长      | `order_id`, `order_status`, `created_at`, `actual_delivery_time`                                     | —                                                      | —                                                                                             | 时区解析、负时长检查       |
| 节点停留时间        | `order_id`                                                                                           | `event_id`, `event_time`, `event_code`, `warehouse_id` | `tracking_event_id`, `shipment_id`, `event_time`, `event_code`, `carrier_id`, `location_code` | 区间定义、事件配对策略     |
| 平均值/中位数/P90   | 对应基础指标字段                                                                                     | 对应基础区间字段                                       | 对应基础区间字段                                                                              | 有效样本、P90 Type 7       |
| 异常率              | `order_id` 及规则声明字段                                                                            | 规则证据字段                                           | 规则证据字段                                                                                  | 规则集合版本、适用性和去重 |
| 取消率              | `order_id`, `order_status`, `created_at`                                                             | —                                                      | —                                                                                             | 趋势时间锚点               |
| 退回率              | `order_id`, `order_status`                                                                           | —                                                      | 可选退回证据                                                                                  | 与取消分开                 |
| 核心履约数据覆盖率  | OT、IF、总时长全部字段                                                                               | —                                                      | —                                                                                             | 完成候选订单分母           |
| 维度对比            | 被比较指标字段，加 `created_at`, `warehouse_id`, `carrier_id`, `destination_region`, `sales_channel` | 被比较指标需要时使用                                   | 被比较指标需要时使用                                                                          | `unknown` 分组、样本警告   |

## 16. 已知限制

- 当前仅定义订单级履约，不覆盖 SKU/订单行级 IF；
- 不自动进行数量单位换算；
- 退货原因、拒收原因和逆向物流指标留待后续范围评估；
- 异常阈值将在阶段 6 基于合成案例和明确规则配置定义；
- 本文定义计算方法，不设置业务目标值或行业基准。

## 17. 阶段 4 API 与数据集组合

- `summary`：总体指标和全部数据警告；
- `trend`：按订单创建日期或周一所在周重新计算指标；
- `distribution`：履约时长或标准节点时长直方图及 P50/P90；
- `breakdown`：仓库、承运商、目的地区、渠道维度重算；
- `order detail`：订单级 OT/IF/OTIF 判定、节点区间、异常证据和警告。

订单、仓库事件和物流轨迹可以分批确认导入，因此 API 明确接收一个订单数据集 ID 和两个可选事件数据集 ID。事件缺失不妨碍订单指标，但相应节点指标返回无样本或低覆盖警告。

## 18. 阶段 7 模拟重算约束

- 模拟基线和方案必须调用本文件对应的同一 `metrics-v1.1.0` 引擎；
- 模拟层不得直接给最终指标加减数值；
- 方案先变换订单或事件副本，再重新计算订单判定、节点区间、分子、分母、覆盖率和分位数；
- 基线与方案分别保留分子、分母、覆盖率，不能只展示百分比差；
- 异常率继续使用 `metric-baseline-rules-v1.0.0`，节点时长缩短不会自动删除未命中的业务异常事件；
- 比例绝对变化在页面以百分点展示，内部仍返回 0–1；基线为 0 时相对变化不可计算；
- 模拟新增 `scenario_id`、输入/方案指纹、随机种子和 `simulation-v1.0.0`，不改变本指标定义版本。

模拟算法、时间传导、承运商经验重采样和误用边界见 [SIMULATION.md](SIMULATION.md)。
