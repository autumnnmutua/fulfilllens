import type {
  AnchorHTMLAttributes,
  MouseEvent,
  PropsWithChildren,
} from "react";

import { useRouting } from "./routing-context";

interface AppLinkProps extends Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
> {
  to: string;
}

export function AppLink({
  children,
  onClick,
  target,
  to,
  ...anchorProps
}: PropsWithChildren<AppLinkProps>) {
  const { navigate } = useRouting();

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      (target !== undefined && target !== "_self")
    ) {
      return;
    }

    event.preventDefault();
    navigate(to);
  };

  return (
    <a {...anchorProps} href={to} target={target} onClick={handleClick}>
      {children}
    </a>
  );
}
