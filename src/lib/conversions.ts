/**
 * Metadata for the generic Convert node — kept dependency-free (no `marked`, no
 * server imports) so the dialog, the Zod schema, and the output registry can all
 * import it without pulling the actual converter implementations (and their
 * heavier deps) into the client bundle. The implementations live in
 * `converters.ts`, keyed by the same `ConversionKind`.
 */

export type ConversionKind =
  | "pdf_to_text"
  | "csv_to_json"
  | "json_to_csv"
  | "html_to_text"
  | "markdown_to_html";

/** How the node's single `input` field is sourced for a given conversion. */
export type ConversionInputKind = "url" | "text";

export type ConversionOption = {
  value: ConversionKind;
  label: string;
  /** Whether `input` is a URL to fetch or a text/data value to transform. */
  inputKind: ConversionInputKind;
  /** Placeholder shown in the dialog's input field. */
  placeholder: string;
  /** One-line explanation shown under the conversion selector. */
  description: string;
};

// Order here drives the dialog's dropdown order.
export const CONVERSION_OPTIONS: readonly ConversionOption[] = [
  {
    value: "pdf_to_text",
    label: "PDF → Plain text",
    inputKind: "url",
    placeholder: "@<googleForm.responses.File>@",
    description:
      "Download a PDF from a URL (incl. private Google Drive links) and extract its text.",
  },
  {
    value: "csv_to_json",
    label: "CSV → JSON",
    inputKind: "text",
    placeholder: "name,email\\nAda,ada@example.com",
    description:
      "Parse CSV text (first row = headers) into an array of JSON objects.",
  },
  {
    value: "json_to_csv",
    label: "JSON → CSV",
    inputKind: "text",
    placeholder: '[{ "name": "Ada", "email": "ada@example.com" }]',
    description:
      "Serialize a JSON object or array of objects into CSV text with a header row.",
  },
  {
    value: "html_to_text",
    label: "HTML → Plain text",
    inputKind: "text",
    placeholder: "<p>Hello <b>world</b></p>",
    description: "Strip HTML tags and decode entities to readable plain text.",
  },
  {
    value: "markdown_to_html",
    label: "Markdown → HTML",
    inputKind: "text",
    placeholder: "# Title\\n\\nSome **bold** text.",
    description: "Render Markdown into an HTML fragment.",
  },
] as const;

export const CONVERSION_KINDS = CONVERSION_OPTIONS.map(
  (o) => o.value,
) as ConversionKind[];

export const conversionOption = (kind: ConversionKind): ConversionOption =>
  CONVERSION_OPTIONS.find((o) => o.value === kind) ?? CONVERSION_OPTIONS[0];
