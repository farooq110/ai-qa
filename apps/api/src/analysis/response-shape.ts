import { findList } from "@ai-qa/test-dsl";

/** What a list endpoint returns, reduced to what test writing needs: field names, types, enum values, two redacted rows. */
export interface ResponseShape {
  /** Where the list sits in the body ("" = the body is the array, "data.items" ...). */
  listPath: string;
  total: number;
  fields: Array<{ name: string; type: "string" | "number" | "boolean" | "other"; /** Distinct values when the field looks like an enum. */ values?: string[] }>;
  sample: Array<Record<string, string | number | boolean | null>>;
}

export const MAX_RESPONSE_BYTES = 1_000_000;
const SECRET_KEY = /pass(word)?|token|secret|authorization|api.?key|card|ssn/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INSPECT_ITEMS = 100;
const MAX_FIELDS = 25;
const MAX_ENUM_VALUES = 8;
const MAX_TEXT = 40;

type Scalar = string | number | boolean | null;

/** One nesting level is flattened to `parent.child`; arrays and deeper objects are dropped. */
function flatten(item: Record<string, unknown>): Record<string, Scalar> {
  const flat: Record<string, Scalar> = {};
  const put = (name: string, value: unknown) => {
    if (SECRET_KEY.test(name)) return;
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) flat[name] = value as Scalar;
  };
  for (const [key, value] of Object.entries(item)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) put(`${key}.${inner}`, innerValue);
    } else put(key, value);
  }
  return flat;
}

const cut = (value: string) => (value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value);

/** Shape of a list response, or null when the body holds no list of records. */
export function summarizeResponse(json: unknown): ResponseShape | null {
  const list = findList(json);
  if (!list || !list.items.length) return null;
  const rows = list.items.slice(0, INSPECT_ITEMS).map(flatten);
  const names = [...new Set(rows.flatMap((row) => Object.keys(row)))].slice(0, MAX_FIELDS);
  const fields = names.map((name): ResponseShape["fields"][number] => {
    const present = rows.map((row) => row[name]).filter((value) => value !== undefined && value !== null);
    const first = present[0];
    const type = typeof first === "string" ? "string" : typeof first === "number" ? "number" : typeof first === "boolean" ? "boolean" : "other";
    const distinct = type === "string" ? [...new Set(present as string[])] : [];
    const isEnum = distinct.length > 0 && distinct.length <= MAX_ENUM_VALUES && present.length > distinct.length && distinct.every((value) => value.length <= 30 && !EMAIL.test(value));
    return { name, type, ...(isEnum ? { values: distinct } : {}) };
  });
  const sample = rows.slice(0, 2).map((row) => Object.fromEntries(names.filter((name) => name in row).map((name) => {
    const value = row[name];
    return [name, typeof value === "string" ? (EMAIL.test(value) ? "<email>" : cut(value)) : value];
  })));
  return { listPath: list.path, total: list.items.length, fields, sample };
}
