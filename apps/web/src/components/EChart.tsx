import {
  BarChart,
  LineChart,
  type BarSeriesOption,
  type LineSeriesOption,
} from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  type GridComponentOption,
  type LegendComponentOption,
  type TitleComponentOption,
  type TooltipComponentOption,
} from "echarts/components";
import * as echarts from "echarts/core";
import type { ComposeOption } from "echarts/core";
import { SVGRenderer } from "echarts/renderers";
import { useEffect, useRef } from "react";

echarts.use([
  BarChart,
  LineChart,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  SVGRenderer,
]);

export type EChartOption = ComposeOption<
  | BarSeriesOption
  | GridComponentOption
  | LegendComponentOption
  | LineSeriesOption
  | TitleComponentOption
  | TooltipComponentOption
>;

interface EChartProps {
  ariaLabel: string;
  option: EChartOption;
  summary?: string;
}

export function EChart({
  ariaLabel,
  option,
  summary = ariaLabel,
}: EChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }

    const chart = echarts.init(container, undefined, {
      renderer: "svg",
    });
    chart.setOption(option);

    const observer = new ResizeObserver(() => {
      chart.resize();
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [option]);

  return (
    <figure className="chart-figure">
      <div
        ref={containerRef}
        className="chart-container"
        role="img"
        aria-label={ariaLabel}
      />
      <figcaption className="chart-summary">图表文字摘要：{summary}</figcaption>
    </figure>
  );
}
