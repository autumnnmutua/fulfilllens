import { Button, Result } from "antd";
import { Component, type ErrorInfo, type PropsWithChildren } from "react";

interface ErrorBoundaryState {
  hasError: boolean;
}

export class ErrorBoundary extends Component<
  PropsWithChildren,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = {
    hasError: false,
  };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return {
      hasError: true,
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (import.meta.env.DEV) {
      console.error("页面渲染失败", error, info);
    }
  }

  private reset = (): void => {
    this.setState({
      hasError: false,
    });
    window.location.assign("/");
  };

  render() {
    if (this.state.hasError) {
      return (
        <main className="fatal-error" role="alert">
          <Result
            status="error"
            title="页面暂时无法显示"
            subTitle="系统没有隐藏该错误。请返回首页重试；若问题持续，请保留浏览器控制台信息用于本地排查。"
            extra={
              <Button type="primary" onClick={this.reset}>
                返回首页
              </Button>
            }
          />
        </main>
      );
    }

    return this.props.children;
  }
}
