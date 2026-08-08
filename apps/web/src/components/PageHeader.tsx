import { Flex, Tag, Typography } from "antd";

interface PageHeaderProps {
  title: string;
  description: string;
  developing?: boolean;
}

export function PageHeader({
  title,
  description,
  developing = false,
}: PageHeaderProps) {
  return (
    <header className="page-heading">
      <Flex align="center" gap="small" wrap>
        <Typography.Title level={1}>{title}</Typography.Title>
        {developing ? <Tag color="gold">开发中</Tag> : null}
      </Flex>
      <Typography.Paragraph>{description}</Typography.Paragraph>
    </header>
  );
}
