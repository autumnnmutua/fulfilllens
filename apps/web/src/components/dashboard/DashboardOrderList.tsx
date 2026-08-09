import {
  ClockCircleOutlined,
  DownloadOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  Flex,
  Grid,
  Pagination,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Timeline,
  Typography,
} from "antd";
import { useState } from "react";

import {
  anomalyLabels,
  formatDateTime,
  formatHours,
  statusLabels,
} from "./formatters";
import { metricsApi } from "../../api/metrics";
import type {
  DashboardOrderItem,
  DashboardOrderPage,
  OrderSort,
  SortDirection,
} from "../../types/dashboard";
import type { DatasetSelection, OrderMetricDetail } from "../../types/metrics";

interface DashboardOrderListProps {
  busy: boolean;
  onExportCsv: () => Promise<void>;
  data: DashboardOrderPage | null;
  selection: DatasetSelection;
  sortBy: OrderSort;
  sortDirection: SortDirection;
  onPageChange: (page: number, pageSize: number) => void;
  onSortChange: (sortBy: OrderSort, sortDirection: SortDirection) => void;
}

const decisionLabels = {
  true: "满足",
  false: "未满足",
  not_computable: "不可计算",
  pending: "待完成",
  excluded: "已排除",
};

function decisionColor(status: OrderMetricDetail["otif"]["status"]): string {
  if (status === "true") {
    return "success";
  }
  if (status === "false") {
    return "error";
  }
  return status === "not_computable" ? "warning" : "default";
}

function AnomalyTags({ order }: { order: DashboardOrderItem }) {
  if (!order.anomaly) {
    return <Tag color="success">未命中基线异常</Tag>;
  }
  return (
    <Flex gap={4} wrap>
      {order.anomaly_types.map((type) => (
        <Tag color="error" key={type}>
          {anomalyLabels[type] ?? type}
        </Tag>
      ))}
    </Flex>
  );
}

export function DashboardOrderList({
  busy,
  onExportCsv,
  data,
  selection,
  sortBy,
  sortDirection,
  onPageChange,
  onSortChange,
}: DashboardOrderListProps) {
  const screens = Grid.useBreakpoint();
  const mobile = screens.md === false;
  const [detail, setDetail] = useState<OrderMetricDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  async function exportCsv() {
    setExportBusy(true);
    setExportError(null);
    try {
      await onExportCsv();
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : "订单明细导出失败，请重试。",
      );
    } finally {
      setExportBusy(false);
    }
  }

  async function openDetail(order: DashboardOrderItem) {
    setDetail(order);
    setDetailBusy(true);
    setDetailError(null);
    try {
      setDetail(await metricsApi.orderDetail(selection, order.order_id));
    } catch (error) {
      setDetailError(
        error instanceof Error ? error.message : "订单证据读取失败，请重试。",
      );
    } finally {
      setDetailBusy(false);
    }
  }

  const sortControls = (
    <Flex gap="small" wrap>
      <Select<OrderSort>
        aria-label="订单排序字段"
        value={sortBy}
        options={[
          { value: "created_at", label: "下单时间" },
          { value: "order_id", label: "订单编号" },
          { value: "fulfillment_duration_hours", label: "履约时长" },
          { value: "order_status", label: "订单状态" },
          { value: "otif", label: "OTIF 判定" },
          { value: "anomaly", label: "异常优先" },
        ]}
        onChange={(next) => onSortChange(next, sortDirection)}
      />
      <Select<SortDirection>
        aria-label="订单排序方向"
        value={sortDirection}
        options={[
          { value: "desc", label: "降序" },
          { value: "asc", label: "升序" },
        ]}
        onChange={(next) => onSortChange(sortBy, next)}
      />
      <Button
        icon={<DownloadOutlined />}
        loading={exportBusy}
        onClick={() => void exportCsv()}
        disabled={!data || data.total === 0}
      >
        导出当前筛选 CSV
      </Button>
    </Flex>
  );

  return (
    <>
      <Card
        className="section-card"
        title="订单明细"
        extra={!mobile ? sortControls : undefined}
      >
        {mobile ? (
          <div className="order-mobile-controls">{sortControls}</div>
        ) : null}
        <Typography.Paragraph>
          共 {data?.total ?? 0} 单；导出沿用当前全局筛选和排序，且对 CSV
          公式前缀做安全转义。异常是版本化基线规则结果，不代表已确认根因。
        </Typography.Paragraph>
        {exportError ? (
          <Alert
            type="error"
            showIcon
            title="订单明细导出失败"
            description={exportError}
          />
        ) : null}
        {data === null || data.total === 0 ? (
          <Empty
            description={
              busy
                ? "正在读取订单"
                : "当前筛选没有订单，请清除部分条件或检查数据覆盖。"
            }
          />
        ) : mobile ? (
          <>
            <Spin spinning={busy}>
              <div className="order-mobile-list">
                {data.items.map((order) => (
                  <div key={order.order_id}>
                    <Card size="small" className="order-mobile-card">
                      <Flex vertical gap="small">
                        <Flex justify="space-between" gap="small" wrap>
                          <Typography.Text strong>
                            {order.order_id}
                          </Typography.Text>
                          <Tag>
                            {statusLabels[order.order_status] ??
                              order.order_status}
                          </Tag>
                        </Flex>
                        <Typography.Text>
                          {formatDateTime(order.created_at)} ·{" "}
                          {order.carrier_id} · {order.destination_region}
                        </Typography.Text>
                        <Typography.Text>
                          OTIF：
                          <Tag color={decisionColor(order.otif.status)}>
                            {decisionLabels[order.otif.status]}
                          </Tag>
                          时长：{formatHours(order.fulfillment_duration_hours)}
                        </Typography.Text>
                        <AnomalyTags order={order} />
                        <Button
                          icon={<ClockCircleOutlined />}
                          onClick={() => void openDetail(order)}
                        >
                          查看履约时间线
                        </Button>
                      </Flex>
                    </Card>
                  </div>
                ))}
              </div>
            </Spin>
            <Pagination
              current={data.page}
              pageSize={data.page_size}
              total={data.total}
              showSizeChanger={false}
              onChange={onPageChange}
            />
          </>
        ) : (
          <Table
            rowKey="order_id"
            loading={busy}
            dataSource={data.items}
            pagination={{
              current: data.page,
              pageSize: data.page_size,
              total: data.total,
              showSizeChanger: true,
              pageSizeOptions: [10, 20, 50, 100],
              showTotal: (total) => `共 ${total} 单`,
            }}
            scroll={{ x: 1180 }}
            onChange={(pagination) =>
              onPageChange(
                pagination.current ?? 1,
                pagination.pageSize ?? data.page_size,
              )
            }
            columns={[
              {
                title: "订单编号",
                dataIndex: "order_id",
                key: "order_id",
                fixed: "left",
                width: 168,
              },
              {
                title: "下单时间",
                dataIndex: "created_at",
                key: "created_at",
                width: 170,
                render: (value: string | null) => formatDateTime(value),
              },
              {
                title: "承运商",
                dataIndex: "carrier_id",
                key: "carrier_id",
                width: 120,
              },
              {
                title: "仓库",
                dataIndex: "warehouse_id",
                key: "warehouse_id",
                width: 110,
              },
              {
                title: "状态",
                dataIndex: "order_status",
                key: "order_status",
                width: 100,
                render: (value: string) => statusLabels[value] ?? value,
              },
              {
                title: "OTIF",
                key: "otif",
                width: 108,
                render: (_, order) => (
                  <Tag color={decisionColor(order.otif.status)}>
                    {decisionLabels[order.otif.status]}
                  </Tag>
                ),
              },
              {
                title: "履约时长",
                dataIndex: "fulfillment_duration_hours",
                key: "duration",
                width: 120,
                render: (value: number | null) => formatHours(value),
              },
              {
                title: "异常标签",
                key: "anomaly",
                width: 210,
                render: (_, order) => <AnomalyTags order={order} />,
              },
              {
                title: "证据",
                key: "action",
                fixed: "right",
                width: 150,
                render: (_, order) => (
                  <Button
                    type="link"
                    icon={<ClockCircleOutlined />}
                    onClick={() => void openDetail(order)}
                  >
                    履约时间线
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Card>

      <Drawer
        title={detail ? `订单 ${detail.order_id}` : "订单证据"}
        open={detail !== null}
        size="large"
        onClose={() => {
          setDetail(null);
          setDetailError(null);
        }}
      >
        <Spin spinning={detailBusy}>
          {detailError ? (
            <Alert
              showIcon
              type="error"
              title="订单证据读取失败"
              description={detailError}
            />
          ) : null}
          {detail ? (
            <Flex vertical gap="large">
              <Alert
                showIcon
                type="info"
                title="当前为阶段 4 可复算履约证据"
                description="这里展示订单关键时间与已配对节点区间；完整扫描事件时间线和诊断规则证据将在阶段 6 补充。"
              />
              <Descriptions
                bordered
                size="small"
                column={1}
                items={[
                  {
                    key: "status",
                    label: "订单状态",
                    children:
                      statusLabels[detail.order_status] ?? detail.order_status,
                  },
                  {
                    key: "dimensions",
                    label: "业务维度",
                    children: `${detail.warehouse_id} / ${detail.carrier_id} / ${detail.destination_region}`,
                  },
                  {
                    key: "duration",
                    label: "履约时长",
                    children: formatHours(detail.fulfillment_duration_hours),
                  },
                  {
                    key: "version",
                    label: "口径 / 规则版本",
                    children: `${detail.definition_version} / ${detail.rule_set_version}`,
                  },
                ]}
              />
              <section>
                <Typography.Title level={3}>订单关键时间</Typography.Title>
                <Timeline
                  items={[
                    {
                      color: "blue",
                      children: `创建：${formatDateTime(detail.created_at)}`,
                    },
                    {
                      color: "orange",
                      children: `承诺送达：${formatDateTime(detail.promised_delivery_time)}`,
                    },
                    {
                      color:
                        detail.actual_delivery_time === null ? "gray" : "green",
                      children: `实际送达：${formatDateTime(detail.actual_delivery_time)}`,
                    },
                  ]}
                />
              </section>
              <section>
                <Typography.Title level={3}>指标判定</Typography.Title>
                <Space direction="vertical">
                  {(
                    [
                      ["OT", detail.ot],
                      ["IF", detail.in_full],
                      ["OTIF", detail.otif],
                    ] satisfies Array<[string, OrderMetricDetail["otif"]]>
                  ).map(([label, typed]) => {
                    return (
                      <Typography.Text key={label}>
                        <Tag color={decisionColor(typed.status)}>
                          {label} · {decisionLabels[typed.status]}
                        </Tag>
                        {typed.reason}
                      </Typography.Text>
                    );
                  })}
                </Space>
              </section>
              <section>
                <Typography.Title level={3}>标准节点区间</Typography.Title>
                {detail.node_durations.length > 0 ? (
                  <Timeline
                    items={detail.node_durations.map((node) => ({
                      color: "blue",
                      children: (
                        <>
                          <Typography.Text strong>
                            {node.display_name} ·{" "}
                            {node.duration_hours.toFixed(1)} 小时
                          </Typography.Text>
                          <br />
                          <Typography.Text>
                            {formatDateTime(node.start_time)} →{" "}
                            {formatDateTime(node.end_time)}
                          </Typography.Text>
                        </>
                      ),
                    }))}
                  />
                ) : (
                  <Empty description="当前关联事件不足，无法形成标准节点区间。" />
                )}
              </section>
              {detail.anomaly_reasons.length > 0 ? (
                <Alert
                  icon={<WarningOutlined />}
                  showIcon
                  type="warning"
                  title="基线异常证据"
                  description={detail.anomaly_reasons.join("；")}
                />
              ) : null}
            </Flex>
          ) : null}
        </Spin>
      </Drawer>
    </>
  );
}
