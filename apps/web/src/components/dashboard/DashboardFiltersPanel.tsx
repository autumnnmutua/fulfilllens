import { ClearOutlined, FilterOutlined } from "@ant-design/icons";
import { Button, Card, Flex, Select, Typography } from "antd";

import type {
  DashboardFilterOptions,
  DashboardFilters,
  FilterOption,
} from "../../types/dashboard";

interface DashboardFiltersPanelProps {
  busy: boolean;
  options: DashboardFilterOptions | null;
  value: DashboardFilters;
  onApply: () => void;
  onChange: (value: DashboardFilters) => void;
  onClear: () => void;
}

function selectOptions(options: FilterOption[]) {
  return options.map((option) => ({
    value: option.value,
    label: `${option.label}（${option.count}）`,
  }));
}

export function DashboardFiltersPanel({
  busy,
  options,
  value,
  onApply,
  onChange,
  onClear,
}: DashboardFiltersPanelProps) {
  const invalidRange =
    value.start_date !== null &&
    value.end_date !== null &&
    value.start_date > value.end_date;

  function update<Key extends keyof DashboardFilters>(
    key: Key,
    nextValue: DashboardFilters[Key],
  ) {
    onChange({ ...value, [key]: nextValue });
  }

  return (
    <Card
      className="section-card dashboard-filter-card"
      title="全局筛选"
      extra={
        <Typography.Text>维度内多选为“或”，维度之间为“且”</Typography.Text>
      }
    >
      <div className="dashboard-filter-grid">
        <label className="dashboard-filter-field">
          <Typography.Text strong>开始日期</Typography.Text>
          <input
            aria-label="开始日期"
            type="date"
            min={options?.minimum_date ?? undefined}
            max={options?.maximum_date ?? undefined}
            value={value.start_date ?? ""}
            onChange={(event) =>
              update("start_date", event.target.value || null)
            }
          />
        </label>
        <label className="dashboard-filter-field">
          <Typography.Text strong>结束日期</Typography.Text>
          <input
            aria-label="结束日期"
            type="date"
            min={options?.minimum_date ?? undefined}
            max={options?.maximum_date ?? undefined}
            value={value.end_date ?? ""}
            onChange={(event) => update("end_date", event.target.value || null)}
          />
        </label>
        <label className="dashboard-filter-field">
          <Typography.Text strong>仓库</Typography.Text>
          <Select
            aria-label="仓库"
            mode="multiple"
            allowClear
            maxTagCount="responsive"
            value={value.warehouses}
            options={selectOptions(options?.warehouses ?? [])}
            onChange={(next) => update("warehouses", next)}
          />
        </label>
        <label className="dashboard-filter-field">
          <Typography.Text strong>承运商</Typography.Text>
          <Select
            aria-label="承运商"
            mode="multiple"
            allowClear
            maxTagCount="responsive"
            value={value.carriers}
            options={selectOptions(options?.carriers ?? [])}
            onChange={(next) => update("carriers", next)}
          />
        </label>
        <label className="dashboard-filter-field">
          <Typography.Text strong>目的地区</Typography.Text>
          <Select
            aria-label="目的地区"
            mode="multiple"
            allowClear
            maxTagCount="responsive"
            value={value.regions}
            options={selectOptions(options?.regions ?? [])}
            onChange={(next) => update("regions", next)}
          />
        </label>
        <label className="dashboard-filter-field">
          <Typography.Text strong>订单状态</Typography.Text>
          <Select
            aria-label="订单状态"
            mode="multiple"
            allowClear
            maxTagCount="responsive"
            value={value.statuses}
            options={selectOptions(options?.statuses ?? [])}
            onChange={(next) => update("statuses", next)}
          />
        </label>
        <label className="dashboard-filter-field">
          <Typography.Text strong>异常类型</Typography.Text>
          <Select
            aria-label="异常类型"
            mode="multiple"
            allowClear
            maxTagCount="responsive"
            value={value.anomaly_types}
            options={selectOptions(options?.anomaly_types ?? [])}
            onChange={(next) => update("anomaly_types", next)}
          />
        </label>
      </div>
      {invalidRange ? (
        <Typography.Paragraph type="danger" role="alert">
          开始日期不能晚于结束日期，请修正后再应用。
        </Typography.Paragraph>
      ) : null}
      <Flex gap="small" wrap>
        <Button
          type="primary"
          icon={<FilterOutlined />}
          loading={busy}
          disabled={invalidRange}
          onClick={onApply}
        >
          应用筛选
        </Button>
        <Button icon={<ClearOutlined />} disabled={busy} onClick={onClear}>
          清除全部
        </Button>
      </Flex>
    </Card>
  );
}
