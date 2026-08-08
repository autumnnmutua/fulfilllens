import { App as AntdApp } from "antd";
import { useMemo, type PropsWithChildren } from "react";

import {
  NotificationContext,
  type NotificationActions,
} from "./notification-context";

export function NotificationProvider({ children }: PropsWithChildren) {
  const { notification } = AntdApp.useApp();

  const actions = useMemo<NotificationActions>(
    () => ({
      showError: (title, description) => {
        notification.error({
          message: title,
          description,
          placement: "topRight",
        });
      },
      showSuccess: (title, description) => {
        notification.success({
          message: title,
          description,
          placement: "topRight",
        });
      },
    }),
    [notification],
  );

  return (
    <NotificationContext.Provider value={actions}>
      {children}
    </NotificationContext.Provider>
  );
}
