import { useEffect } from "react";

import { enhanceAntdAccessibility } from "./antd-accessibility";

export function AntdAccessibilityBridge() {
  useEffect(() => {
    const rootDocument = document;
    const run = () => {
      enhanceAntdAccessibility(rootDocument);
    };

    run();
    const observer = new MutationObserver(run);
    observer.observe(rootDocument.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
    };
  }, []);

  return null;
}
