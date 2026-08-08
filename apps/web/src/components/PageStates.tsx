import { Empty, Flex, Spin, Typography } from "antd";

interface LoadingStateProps {
  label?: string;
}

export function LoadingState({ label = "正在加载" }: LoadingStateProps) {
  return (
    <Flex
      className="page-state"
      vertical
      align="center"
      justify="center"
      gap="middle"
      role="status"
      aria-live="polite"
    >
      <Spin size="large" />
      <Typography.Text>{label}</Typography.Text>
    </Flex>
  );
}

interface EmptyStateProps {
  title: string;
  description: string;
}

export function EmptyState({ title, description }: EmptyStateProps) {
  return (
    <div className="page-state">
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <Flex vertical gap="small">
            <Typography.Title level={4}>{title}</Typography.Title>
            <Typography.Paragraph>{description}</Typography.Paragraph>
          </Flex>
        }
      />
    </div>
  );
}
