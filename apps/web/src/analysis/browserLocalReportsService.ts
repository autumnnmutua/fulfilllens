import { browserLocalAnalyticsService } from "./browserLocalAnalyticsService";
import { browserLocalDiagnosticsService } from "./browserLocalDiagnosticsService";
import { buildClientRecommendations } from "./recommendations";
import type {
  CsvExportKind,
  ReportDocument,
  ReportFormat,
  ReportJob,
  ReportRequest,
  ReportSection,
  ReportSectionCode,
} from "../types/reports";

const jobs = new Map<string, { job: ReportJob; url: string }>();

async function preview(request: ReportRequest): Promise<ReportDocument> {
  const localData = await browserLocalAnalyticsService.load(request.datasets);
  const overview = await browserLocalAnalyticsService.overview(
    request.datasets,
    request.filters,
    {
      grain: request.trend_grain,
      dimension: request.breakdown_dimension,
      breakdownSortBy: "anomaly_order_rate",
      breakdownSortDirection: "desc",
    },
  );
  const diagnostic = await browserLocalDiagnosticsService.analyze({
    datasets: request.datasets,
    timezone: request.filters.timezone,
    rule_overrides: {},
    max_evidence_per_result: request.order_sample_limit,
  });
  const recommendations = buildClientRecommendations(overview);
  const orderPage = await browserLocalAnalyticsService.orders(
    request.datasets,
    request.filters,
    {
      page: 1,
      pageSize: request.order_sample_limit,
      sortBy: "anomaly",
      sortDirection: "desc",
    },
  );
  const title: Record<string, string> = {
    executive_summary: "执行摘要",
    data_quality: "数据质量",
    metrics_overview: "指标总览",
    trend: "趋势",
    node_duration: "节点耗时",
    dimension_breakdown: "维度对比",
    diagnostics: "异常诊断",
    recommendations: "行动建议与管理层简报",
    order_samples: "订单样例",
    simulation: "What-if 情景估算",
    methods_limits: "方法与限制",
  };
  const sections: ReportSection[] = request.sections.map((code) => {
    let data: Record<string, unknown> = {};
    let warnings: string[] = [];
    if (code === "data_quality") {
      data = {
        order_count: overview.context.order_count,
        valid_order_count: overview.context.valid_order_count,
        data_coverage: overview.context.data_coverage,
        warning_count: overview.context.warning_count,
        warnings: overview.warnings,
        status_normalizations: localData.statusNormalizations,
      };
    } else if (code === "metrics_overview")
      data = { metrics: overview.metrics };
    else if (code === "trend")
      data = overview.trend as unknown as Record<string, unknown>;
    else if (code === "node_duration") data = { nodes: overview.nodes };
    else if (code === "dimension_breakdown")
      data = overview.breakdown as unknown as Record<string, unknown>;
    else if (code === "diagnostics") data = { results: diagnostic.results };
    else if (code === "recommendations")
      data = recommendations as unknown as Record<string, unknown>;
    else if (code === "order_samples")
      data = { orders: orderPage.items, total: orderPage.total };
    else if (code === "simulation") {
      data = { result: null };
      warnings = ["浏览器本地报告未选择可复算方案，本节不生成结果。"];
    } else if (code === "methods_limits") {
      data = {
        items: [
          "原始文件和标准化数据保持在当前浏览器。",
          "OT、IF、OTIF 的不可计算订单不进入成功或失败分母。",
          "诊断与建议用于透明核查，不能证明经营因果。",
        ],
      };
    }
    return { code, title: title[code] ?? code, narrative: [], data, warnings };
  });
  return {
    header: {
      analysis_fingerprint: overview.context.analysis_fingerprint,
      analysis_source: overview.context.analysis_source,
      title: `${request.dataset_name}履约分析报告`,
      dataset_name: request.dataset_name,
      time_range_start: overview.context.time_range_start,
      time_range_end: overview.context.time_range_end,
      order_count: overview.context.order_count,
      valid_order_count: overview.context.valid_order_count,
      data_coverage: overview.context.data_coverage,
      generated_at: new Date().toISOString(),
      timezone: request.filters.timezone,
      metrics_definition_version: overview.definition_version,
      diagnostic_rule_version: diagnostic.rule_set_version,
      simulation_version: "browser-simulation-not-selected",
      report_version: "browser-report-v1.1.0",
      renderer_version: "browser-renderer-v1.1.0",
      synthetic_data: false,
    },
    filters: request.filters,
    executive_summary: [
      recommendations.executive_brief.overall_conclusion,
      `当前数据覆盖率为 ${overview.context.data_coverage === null ? "不可计算" : `${(overview.context.data_coverage * 100).toFixed(1)}%`}。`,
      "本报告仅使用当前浏览器内的标准化数据，原始文件未上传。",
    ],
    recommendations,
    sections,
    warnings: [
      ...overview.warnings.map((item) => item.message),
      ...diagnostic.analysis_warnings,
    ],
    source_notes: [
      `指标来源：浏览器本地指标引擎 / ${overview.definition_version}`,
      `建议来源：确定性建议模板 / ${recommendations.definition_version}`,
      `分析指纹：${overview.context.analysis_fingerprint ?? "未提供"}`,
    ],
    chart_map: [],
    identifier_policy: request.include_order_identifiers
      ? "用户已二次确认包含标准订单标识。"
      : "默认最小化展示；不包含姓名、手机号、身份证或详细地址。",
    reading_mode: request.reading_mode,
    reading_guide: [],
    contract_version: "browser-report-v1.1.0",
  };
}

function safeCell(value: unknown): string {
  let output = "";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    output = String(value);
  } else if (value !== null && value !== undefined) {
    output = JSON.stringify(value);
  }
  if (/^[=+\-@]/.test(output)) output = `'${output}`;
  return `"${output.replaceAll('"', '""')}"`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function render(
  document: ReportDocument,
  format: ReportFormat,
  csvKind: CsvExportKind | null,
): Blob {
  if (format === "html") {
    const escaped = JSON.stringify(document, null, 2).replaceAll("<", "&lt;");
    const safeTitle = escapeHtml(document.header.title);
    const safeSummary = escapeHtml(
      document.recommendations.executive_brief.overall_conclusion,
    );
    return new Blob(
      [
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${safeTitle}</title><body><h1>${safeTitle}</h1><h2>管理层简报</h2><p>${safeSummary}</p><h2>可追溯报告数据</h2><pre>${escaped}</pre></body></html>`,
      ],
      { type: "text/html;charset=utf-8" },
    );
  }
  if (format === "csv") {
    const sectionData = (code: string) =>
      document.sections.find((section) => section.code === code)?.data ?? {};
    const rows = (values: unknown[][]) =>
      values.map((row) => row.map(safeCell).join(","));
    let lines: string[];
    if (csvKind === "anomaly_orders") {
      const orders = (sectionData("order_samples").orders ?? []) as Array<
        Record<string, unknown>
      >;
      lines = rows([
        ["order_id", "order_status", "carrier_id", "anomaly_types"],
        ...orders
          .filter((item) => item.anomaly === true)
          .map((item) => [
            item.order_id,
            item.order_status,
            item.carrier_id,
            item.anomaly_types,
          ]),
      ]);
    } else if (csvKind === "data_quality_errors") {
      const warnings = (sectionData("data_quality").warnings ?? []) as Array<
        Record<string, unknown>
      >;
      lines = rows([
        ["code", "message", "order_id", "event_id"],
        ...warnings.map((item) => [
          item.code,
          item.message,
          item.order_id,
          item.event_id,
        ]),
      ]);
    } else if (csvKind === "status_mapping") {
      const mappings = (sectionData("data_quality").status_normalizations ??
        []) as Array<Record<string, unknown>>;
      lines = rows([
        [
          "raw_status",
          "normalized_status",
          "mapping_source",
          "mapping_confidence",
          "occurrences",
        ],
        ...mappings.map((item) => [
          item.raw_status,
          item.normalized_status,
          item.mapping_source,
          item.mapping_confidence,
          item.occurrences,
        ]),
      ]);
    } else if (csvKind === "simulation_comparison") {
      const result = sectionData("simulation").result as
        { comparisons?: Array<Record<string, unknown>> } | null | undefined;
      lines = rows([
        [
          "metric_code",
          "baseline_value",
          "scenario_value",
          "absolute_change",
          "relative_change",
        ],
        ...(result?.comparisons ?? []).map((item) => [
          item.code,
          item.baseline_value,
          item.scenario_value,
          item.absolute_change,
          item.relative_change,
        ]),
      ]);
    } else {
      const metrics = (sectionData("metrics_overview").metrics ?? []) as Array<
        Record<string, unknown>
      >;
      lines = rows([
        [
          "code",
          "display_name",
          "value",
          "unit",
          "numerator",
          "denominator",
          "coverage",
        ],
        ...metrics.map((item) => [
          item.code,
          item.display_name,
          item.value,
          item.unit,
          item.numerator,
          item.denominator,
          item.coverage,
        ]),
      ]);
    }
    return new Blob(["\uFEFF", lines.join("\r\n")], {
      type: "text/csv;charset=utf-8",
    });
  }
  const lines = [
    `# ${document.header.title}`,
    "",
    "## 管理层简报",
    document.recommendations.executive_brief.overall_conclusion,
    "",
    "## 专业行动方案",
    ...document.recommendations.professional_action_plan.flatMap((item) => [
      `### ${item.problem_diagnosis}`,
      `- 数据依据：${item.data_evidence.join("；")}`,
      `- 改善动作：${item.improvement_actions.join("；")}`,
      `- 建议 KPI：${item.suggested_kpis.join("、")}`,
      `- 风险：${item.risk}`,
      "",
    ]),
  ];
  return new Blob(["\uFEFF", lines.join("\n")], {
    type: "text/markdown;charset=utf-8",
  });
}

export const browserLocalReportsService = {
  preview,
  async createJob(
    request: ReportRequest,
    format: ReportFormat,
    csvKind: CsvExportKind | null,
  ): Promise<ReportJob> {
    const csvSections: ReportSectionCode[] = [
      "data_quality",
      "metrics_overview",
      "order_samples",
      "simulation",
    ];
    const document = await preview(
      format === "csv"
        ? {
            ...request,
            order_sample_limit: 50_000,
            sections: [...new Set([...request.sections, ...csvSections])],
          }
        : request,
    );
    const blob = render(document, format, csvKind);
    const jobId = `browser-report-${crypto.randomUUID()}`;
    const timestamp = new Date().toISOString();
    const job: ReportJob = {
      job_id: jobId,
      status: "completed",
      progress: 100,
      message: "浏览器本地报告已生成。",
      format,
      csv_kind: csvKind,
      created_at: timestamp,
      updated_at: timestamp,
      file_name: `fulfilllens-local-report.${format === "markdown" ? "md" : format}`,
      media_type: blob.type,
      size_bytes: blob.size,
      error_code: null,
      download_ready: true,
    };
    jobs.set(jobId, { job, url: URL.createObjectURL(blob) });
    return job;
  },
  job(jobId: string): Promise<ReportJob> {
    const record = jobs.get(jobId);
    if (!record) return Promise.reject(new Error("浏览器本地报告任务不存在。"));
    return Promise.resolve(record.job);
  },
  cancel(jobId: string): Promise<ReportJob> {
    const record = jobs.get(jobId);
    if (!record) return Promise.reject(new Error("浏览器本地报告任务不存在。"));
    URL.revokeObjectURL(record.url);
    const job = {
      ...record.job,
      status: "cancelled" as const,
      download_ready: false,
      message: "已取消并清理报告。",
    };
    jobs.set(jobId, { ...record, job });
    return Promise.resolve(job);
  },
  downloadUrl(jobId: string): string {
    return jobs.get(jobId)?.url ?? "";
  },
};
