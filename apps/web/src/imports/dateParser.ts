export type DateOrder = "DMY" | "MDY";
export type ImportDatePrecision = "date" | "minute" | "second";

export interface ParsedImportDate {
  iso: string;
  precision: ImportDatePrecision;
}

export interface DateOrderInference {
  ambiguous: boolean;
  evidence: string[];
  order: DateOrder | null;
}

export class ImportDateError extends Error {
  readonly code: string;
  readonly suggestion: string;

  constructor(code: string, message: string, suggestion: string) {
    super(message);
    this.name = "ImportDateError";
    this.code = code;
    this.suggestion = suggestion;
  }
}

interface DateParts {
  day: number;
  hour: number;
  minute: number;
  month: number;
  second: number;
  year: number;
}

const englishMonths = new Map(
  [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ].map((month, index) => [month.toLocaleLowerCase("en-US"), index + 1]),
);

function textValue(value: unknown): string {
  if (
    value === null ||
    value === undefined ||
    (typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "bigint")
  ) {
    return "";
  }
  return String(value).normalize("NFKC").trim();
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function partsUtc(parts: DateParts): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
}

function validParts(parts: DateParts): boolean {
  const probe = new Date(partsUtc(parts));
  return (
    probe.getUTCFullYear() === parts.year &&
    probe.getUTCMonth() + 1 === parts.month &&
    probe.getUTCDate() === parts.day &&
    probe.getUTCHours() === parts.hour &&
    probe.getUTCMinutes() === parts.minute &&
    probe.getUTCSeconds() === parts.second
  );
}

function zoneParts(date: Date, timeZone: string): DateParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    day: parts.day ?? 0,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
    month: parts.month ?? 0,
    second: parts.second ?? 0,
    year: parts.year ?? 0,
  };
}

function sameParts(left: DateParts, right: DateParts): boolean {
  return Object.keys(left).every(
    (key) => left[key as keyof DateParts] === right[key as keyof DateParts],
  );
}

function attachTimezone(parts: DateParts, timeZone: string | null): string {
  if (!timeZone) {
    throw new ImportDateError(
      "TIMEZONE_REQUIRED",
      "时间不含时区，必须指定默认 IANA 时区。",
      "选择例如 Asia/Shanghai 后重新校验。",
    );
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(new Date());
  } catch {
    throw new ImportDateError(
      "INVALID_TIMEZONE",
      "默认时区不是可用的 IANA 时区。",
      "选择例如 Asia/Shanghai。",
    );
  }
  const target = partsUtc(parts);
  let instant = target;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const rendered = partsUtc(zoneParts(new Date(instant), timeZone));
    instant -= rendered - target;
  }
  if (!sameParts(zoneParts(new Date(instant), timeZone), parts)) {
    throw new ImportDateError(
      "NONEXISTENT_LOCAL_TIME",
      "该本地时间在所选时区中不存在。",
      "使用带明确 UTC 偏移的 ISO 8601 时间。",
    );
  }
  const alternatives = [instant - 3_600_000, instant + 3_600_000].filter(
    (candidate) => sameParts(zoneParts(new Date(candidate), timeZone), parts),
  );
  if (alternatives.length > 0) {
    throw new ImportDateError(
      "AMBIGUOUS_LOCAL_TIME",
      "该本地时间在夏令时回拨时出现两次。",
      "使用带明确 UTC 偏移的 ISO 8601 时间。",
    );
  }
  const offsetMinutes = Math.round((target - instant) / 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function invalidDate(): never {
  throw new ImportDateError(
    "INVALID_TIME",
    "无法可靠解析日期或时间。",
    "使用 ISO 8601、明确的中文年月日或带英文月份的日期；系统不会按浏览器区域设置猜测。",
  );
}

function normalizedExplicitOffset(text: string): ParsedImportDate | null {
  const gmt = text.match(
    /^(?:[A-Za-z]{3}\s+)?([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s+GMT([+-])(\d{2})(\d{2})(?:\s+\([^)]*\))?$/i,
  );
  if (gmt) {
    const month = englishMonths.get((gmt[1] ?? "").toLocaleLowerCase("en-US"));
    if (!month) return null;
    const parts: DateParts = {
      day: Number(gmt[2]),
      hour: Number(gmt[4]),
      minute: Number(gmt[5]),
      month,
      second: Number(gmt[6] ?? 0),
      year: Number(gmt[3]),
    };
    if (!validParts(parts)) invalidDate();
    return {
      iso: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}${gmt[7]}${gmt[8]}:${gmt[9]}`,
      precision: gmt[6] ? "second" : "minute",
    };
  }

  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(text)) return null;
  const normalized = text.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const matched = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i,
  );
  if (!matched) invalidDate();
  const parts: DateParts = {
    day: Number(matched[3]),
    hour: Number(matched[4]),
    minute: Number(matched[5]),
    month: Number(matched[2]),
    second: Number(matched[6] ?? 0),
    year: Number(matched[1]),
  };
  // Date.parse normalizes impossible ISO dates such as February 30 into the
  // following month. Validate the source wall-clock components first so an
  // explicit offset never turns bad source data into an apparently valid KPI.
  if (!validParts(parts) || !Number.isFinite(Date.parse(normalized)))
    invalidDate();
  const offset = matched[7]?.toUpperCase() === "Z" ? "+00:00" : matched[7];
  return {
    iso: `${matched[1]}-${matched[2]}-${matched[3]}T${matched[4]}:${matched[5]}:${matched[6] ?? "00"}${offset}`,
    precision: matched[6] ? "second" : "minute",
  };
}

function yearFirst(
  text: string,
): { parts: DateParts; precision: ImportDatePrecision } | null {
  const normalized = text
    .replace(/[年/.]/g, "-")
    .replace(/月/g, "-")
    .replace(/日/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const match = normalized.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/,
  );
  if (!match) return null;
  return {
    parts: {
      day: Number(match[3]),
      hour: Number(match[4] ?? 0),
      minute: Number(match[5] ?? 0),
      month: Number(match[2]),
      second: Number(match[6] ?? 0),
      year: Number(match[1]),
    },
    precision: match[4] ? (match[6] ? "second" : "minute") : "date",
  };
}

function englishDayFirst(
  text: string,
): { parts: DateParts; precision: ImportDatePrecision } | null {
  const match = text
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .match(
      /^(?:[A-Za-z]{3}\s+)?(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/i,
    );
  if (!match) return null;
  const month = englishMonths.get((match[2] ?? "").toLocaleLowerCase("en-US"));
  if (!month) return null;
  return {
    parts: {
      day: Number(match[1]),
      hour: Number(match[4] ?? 0),
      minute: Number(match[5] ?? 0),
      month,
      second: Number(match[6] ?? 0),
      year: Number(match[3]),
    },
    precision: match[4] ? (match[6] ? "second" : "minute") : "date",
  };
}

function numericDayMonth(
  text: string,
  fileOrder: DateOrder | null,
): { parts: DateParts; precision: ImportDatePrecision } | null {
  const match = text.match(
    /^(\d{1,2})([/-])(\d{1,2})\2(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?)?$/i,
  );
  if (!match) return null;
  const first = Number(match[1]);
  const second = Number(match[3]);
  const separator = match[2];
  const amPm = match[8]?.toUpperCase();
  let hour = Number(match[5] ?? 0);
  if (amPm) hour = (hour % 12) + (amPm === "PM" ? 12 : 0);
  if (first === second) {
    return {
      parts: {
        day: first,
        hour,
        minute: Number(match[6] ?? 0),
        month: second,
        second: Number(match[7] ?? 0),
        year: Number(match[4]),
      },
      precision: match[5] ? (match[7] ? "second" : "minute") : "date",
    };
  }
  const order: DateOrder | null =
    first > 12 && second <= 12
      ? "DMY"
      : second > 12 && first <= 12
        ? "MDY"
        : amPm
          ? "MDY"
          : separator === "-"
            ? "DMY"
            : fileOrder;
  if (!order) {
    throw new ImportDateError(
      "DATE_ORDER_REQUIRED",
      `日期“${text}”存在日/月顺序歧义。`,
      "请为整个文件选择“日/月/年”或“月/日/年”；系统不会逐行猜测。",
    );
  }
  return {
    parts: {
      day: order === "DMY" ? first : second,
      hour,
      minute: Number(match[6] ?? 0),
      month: order === "DMY" ? second : first,
      second: Number(match[7] ?? 0),
      year: Number(match[4]),
    },
    precision: match[5] ? (match[7] ? "second" : "minute") : "date",
  };
}

export function inferDateOrder(values: unknown[]): DateOrderInference {
  let dmy = 0;
  let mdy = 0;
  let undecidable = 0;
  const evidence: string[] = [];
  values.forEach((value) => {
    const text = textValue(value);
    const match = text.match(
      /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?\s*([AP]M)?)?$/i,
    );
    if (!match) return;
    const first = Number(match[1]);
    const second = Number(match[2]);
    if (first === second) return;
    if (first > 12 && second <= 12) dmy += 1;
    else if (second > 12 && first <= 12) mdy += 1;
    else if (match[4]) mdy += 1;
    else undecidable += 1;
  });
  if (dmy > 0) evidence.push(`${dmy} 个值只能按日/月/年解释`);
  if (mdy > 0) evidence.push(`${mdy} 个值只能按月/日/年解释`);
  if (undecidable > 0) evidence.push(`${undecidable} 个值两种顺序都成立`);
  if (dmy > 0 && mdy > 0) {
    return { ambiguous: true, evidence, order: null };
  }
  const order = dmy > 0 ? "DMY" : mdy > 0 ? "MDY" : null;
  return {
    ambiguous: order === null && undecidable > 0,
    evidence,
    order,
  };
}

export function parseImportDateValue(
  value: unknown,
  timeZone: string | null,
  fileOrder: DateOrder | null = null,
): ParsedImportDate {
  const text = textValue(value);
  if (!text) invalidDate();
  const explicit = normalizedExplicitOffset(text);
  if (explicit) return explicit;
  const parsed =
    yearFirst(text) ??
    englishDayFirst(text) ??
    numericDayMonth(text, fileOrder);
  if (!parsed || !validParts(parsed.parts)) invalidDate();
  if (parsed.precision === "date") {
    return {
      iso: `${parsed.parts.year}-${pad(parsed.parts.month)}-${pad(parsed.parts.day)}`,
      precision: "date",
    };
  }
  return {
    iso: attachTimezone(parsed.parts, timeZone),
    precision: parsed.precision,
  };
}

export function isDateLike(value: unknown): boolean {
  try {
    parseImportDateValue(value, "Asia/Shanghai", "DMY");
    return true;
  } catch {
    try {
      parseImportDateValue(value, "Asia/Shanghai", "MDY");
      return true;
    } catch {
      return false;
    }
  }
}
