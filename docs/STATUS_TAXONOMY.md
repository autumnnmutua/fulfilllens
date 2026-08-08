# FulfillLens CN 状态体系

- 文档状态：Draft for implementation
- 状态版本：status-v1.0-draft
- 更新日期：2026-07-29

## 1. 设计原则

- 状态代码使用稳定英文 `snake_case`，中文名称用于界面显示；
- 原始状态始终保存在 `raw_order_status` 或 `raw_status`；
- 标准状态用于计算、筛选和规则，不反向覆盖原始值；
- 未能可靠映射的状态统一标记为 `unmapped`，不得丢弃；
- 映射必须记录来源、版本和用户修改；
- 状态转换用于发现数据质量和流程变体，不用于删除“不符合主流程”的真实事件。

机器可读枚举位于 `data/schemas/status_codes.schema.json`。

## 2. 订单状态

| 代码         | 中文名称   | 含义                                   | 终态       |
| ------------ | ---------- | -------------------------------------- | ---------- |
| `created`    | 已创建     | 订单已进入系统，尚未确认               | 否         |
| `confirmed`  | 已确认     | 订单有效并准备履约                     | 否         |
| `processing` | 履约处理中 | 正在仓内或发运准备                     | 否         |
| `shipped`    | 已发运     | 已离开仓库，等待运输交付               | 否         |
| `delivered`  | 已交付     | 已完成有效交付                         | 是         |
| `cancelled`  | 已取消     | 订单在完成交付前取消                   | 是         |
| `returned`   | 已退回     | 完成交付后进入退回终态，或运输失败退回 | 是         |
| `unmapped`   | 未映射     | 原始状态无法可靠映射                   | 否，需核查 |

### 2.1 允许转换

```text
created → confirmed → processing → shipped → delivered → returned
    └──────────────→ cancelled
confirmed ─────────→ cancelled
processing ────────→ cancelled
shipped ───────────→ returned
任意状态 ──────────→ unmapped（仅表示映射未知，不改变原业务状态）
```

- `cancelled`、`delivered`、`returned` 为业务终态；若终态后出现新状态，保留事件并标记流程变体；
- `shipped → returned` 允许表示未成功交付即退回；
- `unmapped` 不是业务终态，映射修正后可重新标准化。

## 3. 仓库事件代码

| 代码                      | 中文节点      | 含义                             |
| ------------------------- | ------------- | -------------------------------- |
| `order_received`          | 仓库接单      | 仓库接收到可履约订单             |
| `picking_started`         | 开始拣货      | 拣货作业开始                     |
| `picking_completed`       | 拣货完成      | 拣货作业完成                     |
| `quality_check_started`   | 开始复核      | 复核/质检开始                    |
| `quality_check_failed`    | 复核未通过    | 复核发现问题，需要返工或再次检查 |
| `quality_check_completed` | 复核完成      | 复核通过并完成                   |
| `packing_started`         | 开始打包      | 打包作业开始                     |
| `packing_completed`       | 打包完成      | 打包作业完成                     |
| `ready_to_ship`           | 待出库/待揽收 | 包裹准备交接承运商               |
| `shipped_from_warehouse`  | 仓库出库      | 已完成仓库出库                   |
| `warehouse_cancelled`     | 仓内取消      | 在仓库流程中取消履约             |
| `unmapped`                | 未映射        | 原始仓库状态无法可靠映射         |

### 3.1 主流程与分支

```text
order_received
  → picking_started
  → picking_completed
  → quality_check_started
      → quality_check_failed → picking_started 或 quality_check_started
      → quality_check_completed
  → packing_started
  → packing_completed
  → ready_to_ship
  → shipped_from_warehouse
```

- `warehouse_cancelled` 可从 `shipped_from_warehouse` 之前的任一节点进入；
- 相邻节点可以因源系统粒度不足而缺失，但缺失区间不得伪造时间；
- 复核失败循环和重复作业应作为流程变体保留；
- 同一事件代码多次出现不能自动判定重复，需结合事件主键、时间和上下文。

## 4. 物流轨迹事件代码

| 代码                          | 中文节点      | 含义                           |
| ----------------------------- | ------------- | ------------------------------ |
| `shipment_created`            | 运单已创建    | 承运任务或运单已生成           |
| `carrier_picked_up`           | 承运商已揽收  | 承运商完成首次实物揽收         |
| `origin_departed`             | 始发地已发出  | 离开始发站点                   |
| `in_transit`                  | 运输中        | 处于未细分的运输过程           |
| `arrived_at_hub`              | 到达中转节点  | 到达某枢纽/分拨节点            |
| `departed_hub`                | 离开中转节点  | 离开同一枢纽/分拨节点          |
| `arrived_at_destination_city` | 到达目的城市  | 到达目的地区域                 |
| `out_for_delivery`            | 派送中        | 已交末端配送                   |
| `delivered`                   | 已签收/已交付 | 完成有效交付                   |
| `delivery_failed`             | 派送失败      | 本次派送未完成，可再次派送     |
| `exception`                   | 运输异常      | 出现天气、破损、地址等异常代码 |
| `return_initiated`            | 开始退回      | 启动逆向退回流程               |
| `returned`                    | 已退回        | 退回完成                       |
| `unmapped`                    | 未映射        | 原始物流状态无法可靠映射       |

### 4.1 主流程与允许分支

```text
shipment_created
  → carrier_picked_up
  → origin_departed
  → in_transit
  → arrived_at_hub ↔ departed_hub（可重复多个 location_code）
  → arrived_at_destination_city
  → out_for_delivery
      → delivery_failed → out_for_delivery
      → delivered

任意运输节点 → exception → 原流程下一节点或 return_initiated
任意未完成节点 → return_initiated → returned
```

- `exception` 是观察事件，不默认表示终止；
- `delivery_failed` 允许再次进入 `out_for_delivery`；
- 多次枢纽进出按 `shipment_id`、`location_code` 和时间配对；
- `delivered` 后出现 `return_initiated`、`returned` 可表示售后退回；
- 跳过中间节点可能是数据覆盖不足，不应自动补造事件。

## 5. 未知状态策略

1. 保存原始值：
   - 订单使用 `raw_order_status`；
   - 仓库和物流事件使用 `raw_status`。
2. 标准代码设置为 `unmapped`；
3. 保存映射上下文：数据类型、原始列、原始值、出现次数、首末出现时间；
4. 展示未映射状态列表，允许用户选择标准代码；
5. 用户确认后保存映射版本并重新计算；
6. 未映射事件不得用于需要明确节点的停留时间，但仍进入数据质量覆盖统计；
7. 不用模糊相似度静默决定业务状态。

## 6. 映射规范

### 6.1 查找前规范化

查找键可以进行：

- Unicode NFKC 规范化；
- 去除首尾空白；
- 连续空白折叠为一个空格；
- ASCII 大小写折叠；
- 常见全角标点转半角。

`raw_status` 本身不得被修改。

### 6.2 优先级

1. 当前数据集经用户确认的精确映射；
2. 已保存且版本兼容的映射配置；
3. 内置精确同义词映射；
4. 标准英文代码完全匹配；
5. `unmapped`。

包含否定、失败、取消、退回等词时不得仅按部分字符串匹配。

### 6.3 中文同义词示例

以下仅是内置候选，不替代人工确认：

| 数据类型 | 原始中文候选                 | 标准代码                  | 注意                         |
| -------- | ---------------------------- | ------------------------- | ---------------------------- |
| 订单     | `订单已创建`、`已下单`       | `created`                 | 不等于仓库已接单             |
| 订单     | `已确认`、`已审核`           | `confirmed`               | “审核失败”不得映射           |
| 订单     | `处理中`、`履约中`           | `processing`              | 需排除“异常处理中”等歧义文本 |
| 订单     | `已发货`                     | `shipped`                 | 只在订单表上下文使用         |
| 订单     | `已完成`、`已签收`           | `delivered`               | “部分签收”需人工确认         |
| 订单     | `已取消`、`交易关闭`         | `cancelled`               | 关闭原因单独保留             |
| 订单     | `已退回`、`退货完成`         | `returned`                | 与退款状态区分               |
| 仓库     | `仓库接单`、`订单已下发`     | `order_received`          | 不等于订单创建               |
| 仓库     | `开始拣货`、`拣货中`         | `picking_started`         | “拣货完成”需精确优先         |
| 仓库     | `拣货完成`、`配货完成`       | `picking_completed`       | —                            |
| 仓库     | `开始复核`、`复核中`         | `quality_check_started`   | —                            |
| 仓库     | `复核失败`、`质检不通过`     | `quality_check_failed`    | 不得映射为完成               |
| 仓库     | `复核完成`、`质检通过`       | `quality_check_completed` | —                            |
| 仓库     | `开始打包`、`打包中`         | `packing_started`         | —                            |
| 仓库     | `打包完成`                   | `packing_completed`       | —                            |
| 仓库     | `待出库`、`待揽收`           | `ready_to_ship`           | 两者可在后续细分，MVP 统一   |
| 仓库     | `已出库`                     | `shipped_from_warehouse`  | 不等于承运商已揽收           |
| 物流     | `已揽件`、`快件已揽收`       | `carrier_picked_up`       | —                            |
| 物流     | `运输中`、`在途`             | `in_transit`              | 低粒度通用状态               |
| 物流     | `到达分拨中心`、`到达中转场` | `arrived_at_hub`          | 需保留位置代码               |
| 物流     | `离开分拨中心`、`发往下一站` | `departed_hub`            | “发往下一站”可能歧义         |
| 物流     | `派送中`、`正在派件`         | `out_for_delivery`        | —                            |
| 物流     | `已签收`、`妥投`             | `delivered`               | “拒收”不得映射               |
| 物流     | `派送失败`、`未妥投`         | `delivery_failed`         | —                            |
| 物流     | `运输异常`、`物流异常`       | `exception`               | 具体原因放 `exception_code`  |
| 物流     | `退回中`                     | `return_initiated`        | —                            |
| 物流     | `已退回`、`退回完成`         | `returned`                | —                            |

## 7. 转换校验结果

状态转换检查输出至少包含：

```text
order_id
shipment_id（如适用）
from_code
to_code
from_time
to_time
validation_result
reason_code
taxonomy_version
```

`validation_result` 可为：

- `valid`：符合主流程或允许分支；
- `valid_variant`：允许但非主流程，例如返工或再次派送；
- `missing_intermediate`：可能缺少中间事件；
- `out_of_order`：时间或序列倒置；
- `invalid_transition`：未定义转换；
- `unmapped`：至少一个状态未映射。

## 8. 版本与变更

- 状态代码删除或含义变化属于破坏性变更；
- 新增同义词通常为兼容变更，但必须增加映射回归测试；
- 修改映射优先级、允许转换或状态含义时更新状态版本；
- 页面、API、诊断和报告必须展示所用状态版本。
