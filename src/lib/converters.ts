/**
 * Implementations for the generic Convert node. Each pure converter is a
 * `(input: string) => unknown` keyed by `ConversionKind` in `syncConverters`, so
 * adding a new synchronous conversion is a one-line change here (+ one entry in
 * `conversions.ts`). The `pdf_to_text` conversion is intentionally NOT here — it
 * needs an async network fetch (and per-user Drive auth), so the executor handles
 * it via `resume-fetch.ts` directly.
 *
 * All converters are dependency-light and serverless-safe (no native modules),
 * and throw plain `Error`s on bad input; the executor maps those to
 * `NonRetriableError` so a malformed payload isn't retried.
 */

import { decode } from "html-entities";
import { marked } from "marked";
import type { ConversionKind } from "@/lib/conversions";

/** Converters that run synchronously on an in-memory string (no I/O). */
export type SyncConversionKind = Exclude<ConversionKind, "pdf_to_text">;

/**
 * RFC 4180-ish CSV parser: handles quoted fields, escaped quotes (`""`), and
 * commas / newlines inside quotes. Returns rows of raw string cells.
 */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (inQuotes) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++; // skip the escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }

  // Flush the trailing field/row unless the input ended on a clean newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** CSV text (first row = headers) -> array of objects. */
export function csvToJson(input: string): Record<string, string>[] {
  const rows = parseCsv(input.trim());
  if (rows.length === 0) return [];
  const headers = rows[0];
  return rows.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    headers.forEach((header, idx) => {
      obj[header] = cells[idx] ?? "";
    });
    return obj;
  });
}

const csvEscape = (value: unknown): string => {
  const str =
    value == null
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

/** A JSON object / array of objects -> CSV text with a header row. */
export function jsonToCsv(input: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("Input is not valid JSON");
  }

  const items = (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (item): item is Record<string, unknown> =>
      !!item && typeof item === "object" && !Array.isArray(item),
  );
  if (items.length === 0) {
    throw new Error("JSON must be an object or an array of objects");
  }

  // Union of keys, preserving first-seen order across all rows.
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    for (const key of Object.keys(item)) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }

  const lines = [headers.map(csvEscape).join(",")];
  for (const item of items) {
    lines.push(headers.map((h) => csvEscape(item[h])).join(","));
  }
  return lines.join("\n");
}

/** HTML -> readable plain text (tags stripped, entities decoded). */
export function htmlToText(input: string): string {
  const withoutScripts = input
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  const withBreaks = withoutScripts
    .replace(/<(?:br|hr)\s*\/?>/gi, "\n")
    .replace(
      /<\/(?:p|div|li|tr|h[1-6]|section|article|header|footer|blockquote)>/gi,
      "\n",
    );
  const stripped = withBreaks.replace(/<[^>]+>/g, "");
  return decode(stripped)
    .replace(/ /g, " ") // normalize non-breaking spaces (&nbsp;)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Markdown -> HTML fragment. */
export function markdownToHtml(input: string): string {
  return marked.parse(input, { async: false }) as string;
}

export const syncConverters: Record<
  SyncConversionKind,
  (input: string) => unknown
> = {
  csv_to_json: csvToJson,
  json_to_csv: jsonToCsv,
  html_to_text: htmlToText,
  markdown_to_html: markdownToHtml,
};
