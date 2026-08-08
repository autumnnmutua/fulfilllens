import { Button, Result } from "antd";

import { AppLink } from "../app/AppLink";

export function NotFoundPage() {
  return (
    <Result
      status="404"
      title="页面不存在"
      subTitle="该地址不属于当前 FulfillLens CN 路由。"
      extra={
        <Button type="primary">
          <AppLink to="/">返回首页</AppLink>
        </Button>
      }
    />
  );
}
