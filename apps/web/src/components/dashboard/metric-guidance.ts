interface MetricGuidance {
  explanation: string;
  direction: string;
  caution: string;
  requiresContext: boolean;
}

const GUIDANCE: Record<string, MetricGuidance> = {
  ot_rate: {
    explanation: "承诺时间内送达的可计算订单占比。",
    direction: "通常越高越好。",
    caution: "缺承诺或实际送达时间的订单不进入分母。",
    requiresContext: true,
  },
  if_rate: {
    explanation: "实际交付数量达到订购数量的可计算订单占比。",
    direction: "通常越高越好。",
    caution: "缺数量的订单不可计算；第一版按订单整体判断。",
    requiresContext: true,
  },
  otif_rate: {
    explanation: "同时按时且足量交付的订单占比。",
    direction: "通常越高越好。",
    caution: "必须同时看分母、覆盖率和不可计算数量。",
    requiresContext: true,
  },
  fulfillment_duration_mean_hours: {
    explanation: "从订单创建到实际交付的平均耗时。",
    direction: "在服务承诺一致时通常越低越快。",
    caution: "易受少量极慢订单影响，要和 P50、P90 一起看。",
    requiresContext: true,
  },
  fulfillment_duration_median_hours: {
    explanation: "一半可计算订单的耗时不超过此值。",
    direction: "在可比条件下通常越低越好。",
    caution: "不代表最慢订单，也不能替代 P90。",
    requiresContext: false,
  },
  fulfillment_duration_p90_hours: {
    explanation: "90% 可计算订单的耗时不超过此值，用来观察长尾。",
    direction: "在可比条件下通常越低越好。",
    caution: "小样本、低覆盖或业务结构不同时不能直接排名。",
    requiresContext: true,
  },
  anomaly_order_rate: {
    explanation: "至少触发一条透明异常规则的订单占比。",
    direction: "越高表示需要核查的订单更多。",
    caution: "规则触发不是已证实原因，也不代表责任归属。",
    requiresContext: true,
  },
};

export function metricGuidance(code: string): MetricGuidance | undefined {
  return GUIDANCE[code];
}
