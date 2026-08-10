import fieldCatalogJson from "../../../../data/schemas/import_field_catalog.json";
import orderSchemaJson from "../../../../data/schemas/order.schema.json";
import statusSchemaJson from "../../../../data/schemas/status_codes.schema.json";
import trackingSchemaJson from "../../../../data/schemas/tracking_event.schema.json";
import warehouseSchemaJson from "../../../../data/schemas/warehouse_event.schema.json";

import type { DataType, FieldDefinition } from "../types/imports";

interface FieldCatalog {
  aliases: Record<string, string[]>;
  auxiliary_aliases: Record<string, string[]>;
  labels: Record<string, string>;
}

interface JsonSchema {
  properties: Record<string, Record<string, unknown>>;
  required: string[];
}

export interface ImportContract {
  dataType: DataType;
  fields: FieldDefinition[];
  normalizedStatusField: string;
  primaryField: string;
  rawStatusField: string;
  schema: JsonSchema;
  statusCodes: Set<string>;
  auxiliaryAliases: Record<string, string[]>;
}

const fieldCatalog: FieldCatalog = fieldCatalogJson;
const schemas: Record<DataType, JsonSchema> = {
  orders: orderSchemaJson,
  tracking_events: trackingSchemaJson,
  warehouse_events: warehouseSchemaJson,
};

const primaryFields: Record<DataType, string> = {
  orders: "order_id",
  tracking_events: "tracking_event_id",
  warehouse_events: "event_id",
};

const statusFields: Record<DataType, { normalized: string; raw: string }> = {
  orders: { normalized: "order_status", raw: "raw_order_status" },
  tracking_events: { normalized: "event_code", raw: "raw_status" },
  warehouse_events: { normalized: "event_code", raw: "raw_status" },
};

const statusDefinitions = statusSchemaJson.$defs as Record<
  string,
  { enum: string[] }
>;
const statusDefinitionNames: Record<DataType, string> = {
  orders: "orderStatus",
  tracking_events: "trackingEventCode",
  warehouse_events: "warehouseEventCode",
};

function schemaType(definition: Record<string, unknown>): string {
  if ("$ref" in definition) return "status";
  const valueType = definition.type;
  if (Array.isArray(valueType)) {
    return (valueType as unknown[])
      .filter(
        (value): value is string =>
          typeof value === "string" && value !== "null",
      )
      .join("/");
  }
  const anyOf = definition.anyOf;
  if (Array.isArray(anyOf)) {
    return (anyOf as unknown[])
      .map((option) => {
        if (typeof option !== "object" || option === null) return "";
        const optionType = (option as Record<string, unknown>).type;
        return typeof optionType === "string" ? optionType : "";
      })
      .filter((value) => value && value !== "null")
      .join("/");
  }
  return typeof valueType === "string" ? valueType : "unknown";
}

export function getImportContract(dataType: DataType): ImportContract {
  const schema = schemas[dataType];
  const required = new Set(schema.required);
  const status = statusFields[dataType];
  return {
    dataType,
    auxiliaryAliases: fieldCatalog.auxiliary_aliases,
    fields: Object.entries(schema.properties).map(([field, definition]) => ({
      aliases: fieldCatalog.aliases[field] ?? [],
      field,
      label: fieldCatalog.labels[field] ?? field,
      required: required.has(field),
      value_type: schemaType(definition),
    })),
    normalizedStatusField: status.normalized,
    primaryField: primaryFields[dataType],
    rawStatusField: status.raw,
    schema,
    statusCodes: new Set(
      statusDefinitions[statusDefinitionNames[dataType]]?.enum ?? [],
    ),
  };
}

export const dataTypeLabels: Record<DataType, string> = {
  orders: "订单数据",
  tracking_events: "物流轨迹数据",
  warehouse_events: "仓库作业数据",
};

export const supportedDataTypes: DataType[] = [
  "orders",
  "warehouse_events",
  "tracking_events",
];
