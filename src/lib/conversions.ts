/**
 * Metadata + capability matrix for the generic Convert node — kept
 * dependency-free (no `marked`, no `unpdf`, no server imports) so the dialog,
 * the Zod schema, and the output registry can all import it without pulling the
 * actual converter implementations (and their heavier deps) into the client
 * bundle. The implementations live in `converters.ts` (in-process, text) keyed
 * by the same `(from, to)` pair.
 *
 * The Convert node is modeled as a DYNAMIC source + FIXED target: the user
 * always picks the definite output format they (or the next node) need, while
 * the input format is auto-detected at runtime. This lets a user who doesn't
 * know exactly what they'll receive still guarantee a stable output (e.g. "give
 * me plain text" regardless of whether a PDF or an HTML page arrives).
 *
 * `CONVERSIONS` is the single source of truth: the dialog dropdowns, the schema
 * enum, the output registry, and the executor's dispatch all derive from it, so
 * adding a conversion is a one-line change here (+ its handler). Nothing
 * re-declares the format list.
 */

/** Every format the Convert node can read from or write to. */
export type Format =
  | "text"
  | "json"
  | "csv"
  | "html"
  | "markdown"
  | "pdf"
  | "jpg"
  | "png"
  | "webp"
  | "mp4"
  | "mov"
  | "mp3"
  | "youtube_url"
  | "instagram_url";

export type FormatCategory =
  | "text"
  | "document"
  | "image"
  | "video"
  | "audio"
  | "url";

export type FormatMeta = {
  label: string;
  category: FormatCategory;
  /** Binary formats are produced as files (→ blob storage), never inline text. */
  binary: boolean;
  /** File extension used for blob keys / downloads (binary formats). */
  ext?: string;
  /** Output MIME type (binary) / expected content-type hint (detection). */
  mime?: string;
  /** URL path extensions that identify this format during auto-detection. */
  extensions?: string[];
  /** Placeholder shown in the dialog's input field when this is the source. */
  inputPlaceholder?: string;
};

export const FORMAT_META: Record<Format, FormatMeta> = {
  text: { label: "Plain text", category: "text", binary: false },
  json: {
    label: "JSON",
    category: "text",
    binary: false,
    extensions: ["json"],
    inputPlaceholder: '[{ "name": "Ada", "email": "ada@example.com" }]',
  },
  csv: {
    label: "CSV",
    category: "text",
    binary: false,
    extensions: ["csv"],
    inputPlaceholder: "name,email\\nAda,ada@example.com",
  },
  html: {
    label: "HTML",
    category: "text",
    binary: false,
    extensions: ["html", "htm"],
    inputPlaceholder: "<p>Hello <b>world</b></p>",
  },
  markdown: {
    label: "Markdown",
    category: "text",
    binary: false,
    extensions: ["md", "markdown"],
    inputPlaceholder: "# Title\\n\\nSome **bold** text.",
  },
  pdf: {
    label: "PDF",
    category: "document",
    binary: true,
    ext: "pdf",
    mime: "application/pdf",
    extensions: ["pdf"],
    inputPlaceholder: "@<googleForm.responses.File>@",
  },
  jpg: {
    label: "JPG",
    category: "image",
    binary: true,
    ext: "jpg",
    mime: "image/jpeg",
    extensions: ["jpg", "jpeg"],
    inputPlaceholder: "https://example.com/photo.png",
  },
  png: {
    label: "PNG",
    category: "image",
    binary: true,
    ext: "png",
    mime: "image/png",
    extensions: ["png"],
    inputPlaceholder: "https://example.com/photo.jpg",
  },
  webp: {
    label: "WebP",
    category: "image",
    binary: true,
    ext: "webp",
    mime: "image/webp",
    extensions: ["webp"],
    inputPlaceholder: "https://example.com/photo.png",
  },
  mp4: {
    label: "MP4",
    category: "video",
    binary: true,
    ext: "mp4",
    mime: "video/mp4",
    extensions: ["mp4"],
    inputPlaceholder: "https://example.com/clip.mov",
  },
  mov: {
    label: "MOV",
    category: "video",
    binary: true,
    ext: "mov",
    mime: "video/quicktime",
    extensions: ["mov"],
    inputPlaceholder: "https://example.com/clip.mp4",
  },
  mp3: {
    label: "MP3",
    category: "audio",
    binary: true,
    ext: "mp3",
    mime: "audio/mpeg",
    extensions: ["mp3"],
    inputPlaceholder: "https://example.com/clip.mp4",
  },
  youtube_url: {
    label: "YouTube URL",
    category: "url",
    binary: false,
    inputPlaceholder: "https://www.youtube.com/watch?v=...",
  },
  instagram_url: {
    label: "Instagram URL",
    category: "url",
    binary: false,
    inputPlaceholder: "https://www.instagram.com/reel/...",
  },
};

/**
 * How the executor runs a given `(from, to)` conversion:
 *   - "text-sync":  a pure in-process transform on a string (see `converters.ts`).
 *   - "text-fetch": download the source URL and extract text (async network I/O;
 *                   the executor handles it via `resume-fetch.ts`).
 *   - "binary":     output is a file — routed to an external API + blob storage
 *                   (Phase 3). Declared here so the matrix is the single source
 *                   of truth, even before the handler lands.
 */
export type ConversionEngine = "text-sync" | "text-fetch" | "binary";

export type ConversionDescriptor = {
  from: Format;
  to: Format;
  engine: ConversionEngine;
  /** Human-readable label, e.g. "PDF → Plain text". */
  label: string;
  /** One-line explanation shown in the dialog. */
  description: string;
};

/** In-process text conversions (engine `text-sync`/`text-fetch`). */
const TEXT_CONVERSIONS: readonly ConversionDescriptor[] = [
  {
    from: "pdf",
    to: "text",
    engine: "text-fetch",
    label: "PDF → Plain text",
    description:
      "Download a PDF from a URL (incl. private Google Drive links) and extract its text.",
  },
  {
    from: "html",
    to: "text",
    engine: "text-sync",
    label: "HTML → Plain text",
    description: "Strip HTML tags and decode entities to readable plain text.",
  },
  {
    from: "csv",
    to: "json",
    engine: "text-sync",
    label: "CSV → JSON",
    description:
      "Parse CSV text (first row = headers) into an array of JSON objects.",
  },
  {
    from: "json",
    to: "csv",
    engine: "text-sync",
    label: "JSON → CSV",
    description:
      "Serialize a JSON object or array of objects into CSV text with a header row.",
  },
  {
    from: "markdown",
    to: "html",
    engine: "text-sync",
    label: "Markdown → HTML",
    description: "Render Markdown into an HTML fragment.",
  },
];

// Interchangeable raster image formats — every ordered pair is a valid binary
// conversion, so the list is generated rather than hand-written (no duplication).
const IMAGE_FORMATS: readonly Format[] = ["jpg", "png", "webp"];

/**
 * Binary conversions (engine `binary`) — output is a file, so the executor runs
 * them through the external provider (CloudConvert) and stores the result in
 * blob storage, threading a `BlobHandle` instead of bytes. Generated from format
 * groups so adding a format (e.g. `gif`, `avi`) is a one-line change to a group.
 */
function buildBinaryConversions(): ConversionDescriptor[] {
  const out: ConversionDescriptor[] = [];
  const add = (from: Format, to: Format) => {
    out.push({
      from,
      to,
      engine: "binary",
      label: `${FORMAT_META[from].label} → ${FORMAT_META[to].label}`,
      description: `Convert ${FORMAT_META[from].label} to ${FORMAT_META[to].label}.`,
    });
  };

  // image ↔ image (every ordered pair)
  for (const from of IMAGE_FORMATS) {
    for (const to of IMAGE_FORMATS) {
      if (from !== to) add(from, to);
    }
  }
  // image → PDF and PDF → image
  for (const img of IMAGE_FORMATS) {
    add(img, "pdf");
    add("pdf", img);
  }
  // video container swaps + audio extraction
  add("mp4", "mov");
  add("mov", "mp4");
  add("mp4", "mp3");
  add("mov", "mp3");

  return out;
}

/**
 * The capability matrix — the single source of truth. Text conversions first
 * (so `TARGET_FORMATS[0]` stays `text`), then the generated binary set. Order
 * drives the dialog's dropdown order.
 */
export const CONVERSIONS: readonly ConversionDescriptor[] = [
  ...TEXT_CONVERSIONS,
  ...buildBinaryConversions(),
];

/** Stable key for a `(from, to)` pair, shared with `converters.ts`. */
export const pairKey = (from: Format, to: Format): string => `${from}:${to}`;

const CONVERSIONS_BY_PAIR = new Map<string, ConversionDescriptor>(
  CONVERSIONS.map((c) => [pairKey(c.from, c.to), c]),
);

/** The descriptor for a `(from, to)` pair, or `undefined` if unsupported. */
export const resolveConversion = (
  from: Format,
  to: Format,
): ConversionDescriptor | undefined =>
  CONVERSIONS_BY_PAIR.get(pairKey(from, to));

/** Whether a `(from, to)` conversion is supported. */
export const canConvert = (from: Format, to: Format): boolean =>
  CONVERSIONS_BY_PAIR.has(pairKey(from, to));

/** Every format that can be selected as a fixed target (deduped, order-stable). */
export const TARGET_FORMATS: Format[] = [
  ...new Set(CONVERSIONS.map((c) => c.to)),
];

/** Every format that appears as a source of at least one conversion. */
export const SOURCE_FORMATS: Format[] = [
  ...new Set(CONVERSIONS.map((c) => c.from)),
];

/** The source formats that can produce a given target (for the dialog). */
export const sourcesForTarget = (to: Format): Format[] =>
  CONVERSIONS.filter((c) => c.to === to).map((c) => c.from);

const isFormat = (value: string): value is Format => value in FORMAT_META;

/** Narrows an arbitrary string to a `Format`, or `undefined`. */
export const asFormat = (
  value: string | undefined | null,
): Format | undefined => (value && isFormat(value) ? value : undefined);

/**
 * Whether the dialog should render a single-line URL input vs a multiline text
 * area. A pinned binary/url source (or a target whose only sources are
 * file-based) means the user supplies a URL; otherwise they paste content.
 */
export const inputKindForSelection = (
  to: Format,
  from?: Format,
): "url" | "text" => {
  if (from) return FORMAT_META[from].binary ? "url" : "text";
  const sources = sourcesForTarget(to);
  return sources.length > 0 && sources.every((s) => FORMAT_META[s].binary)
    ? "url"
    : "text";
};

/** Placeholder for the dialog's input field given the current selection. */
export const inputPlaceholderFor = (to: Format, from?: Format): string => {
  if (from) return FORMAT_META[from].inputPlaceholder ?? "";
  const [firstSource] = sourcesForTarget(to);
  return firstSource ? (FORMAT_META[firstSource].inputPlaceholder ?? "") : "";
};

/** Dialog description under the Target select for the current selection. */
export const describeSelection = (to: Format, from?: Format): string => {
  if (from) {
    return (
      resolveConversion(from, to)?.description ??
      `Convert ${FORMAT_META[from].label} to ${FORMAT_META[to].label}.`
    );
  }
  const sources = sourcesForTarget(to)
    .map((s) => FORMAT_META[s].label)
    .join(", ");
  return sources
    ? `Auto-detect the input (${sources}) and convert it to ${FORMAT_META[to].label}.`
    : `Convert the input to ${FORMAT_META[to].label}.`;
};

/**
 * Maps a legacy single-enum `conversion` value (pre-restructure node data) to
 * its `(from, to)` pair, so old workflows keep running without a data migration.
 * Returns `undefined` for unknown values.
 */
const LEGACY_CONVERSION_PAIRS: Record<string, { from: Format; to: Format }> = {
  pdf_to_text: { from: "pdf", to: "text" },
  html_to_text: { from: "html", to: "text" },
  csv_to_json: { from: "csv", to: "json" },
  json_to_csv: { from: "json", to: "csv" },
  markdown_to_html: { from: "markdown", to: "html" },
};

export const legacyConversionToPair = (
  conversion: string | undefined | null,
): { from: Format; to: Format } | undefined =>
  conversion ? LEGACY_CONVERSION_PAIRS[conversion] : undefined;

const HAS_PROTOCOL_RE = /^https?:\/\//i;
// A Google Drive file ID / Forms upload: 25+ URL-safe base64 chars, no dots/slashes.
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{25,}$/;

/** Extracts a lowercased path extension from a URL, if any. */
function urlExtension(url: string): string | undefined {
  try {
    const path = HAS_PROTOCOL_RE.test(url)
      ? new URL(url).pathname
      : url.split("?")[0];
    const match = path.toLowerCase().match(/\.([a-z0-9]+)$/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

const EXT_TO_FORMAT: Record<string, Format> = Object.entries(
  FORMAT_META,
).reduce<Record<string, Format>>((acc, [format, meta]) => {
  for (const ext of meta.extensions ?? []) acc[ext] = format as Format;
  return acc;
}, {});

/**
 * A detected source format plus how much to trust it. `confident` is `false`
 * only for the generic "downloadable URL with an unknown/absent extension →
 * `pdf`" fallback — a placeholder that's safe for text targets (the text-fetch
 * path decodes anything) but must NOT be forwarded to the binary provider as an
 * `input_format` hint, since the real file could be an image/video.
 */
export type FormatDetection = { format: Format; confident: boolean };

/**
 * Best-effort source-format detection from the raw input, used when the user
 * leaves the source on "Auto-detect". Precedence:
 *   1. Social URLs (YouTube / Instagram host).                        [confident]
 *   2. Known file extension in a URL/path.                            [confident]
 *   3. Any other URL or Google Drive source → treated as a downloadable
 *      document (`pdf`); safe for text targets, but a guess.        [unconfident]
 *   4. Inline content sniffing: JSON, HTML, Markdown, CSV, plain text. [confident]
 *
 * Returns `undefined` only for empty input. Runtime byte/content-type sniffing
 * (for binary inputs) is layered on top of this by the executor in later phases.
 */
export function detectFormat(input: string): FormatDetection | undefined {
  const value = input.trim();
  if (!value) return undefined;

  const confident = (format: Format): FormatDetection => ({
    format,
    confident: true,
  });

  const looksLikeUrl = HAS_PROTOCOL_RE.test(value);

  if (looksLikeUrl) {
    const host = (() => {
      try {
        return new URL(value).hostname.toLowerCase();
      } catch {
        return "";
      }
    })();
    if (/(?:^|\.)(youtube\.com|youtu\.be)$/.test(host))
      return confident("youtube_url");
    if (/(?:^|\.)instagram\.com$/.test(host)) return confident("instagram_url");
  }

  if (looksLikeUrl || DRIVE_ID_RE.test(value)) {
    const ext = urlExtension(value);
    if (ext && EXT_TO_FORMAT[ext]) return confident(EXT_TO_FORMAT[ext]);
    // Unknown/absent extension on a URL or a bare Drive ID: treat as a
    // downloadable document so the text-fetch path can extract its text. This is
    // a guess — flagged unconfident so the binary path won't send it as a hint.
    return { format: "pdf", confident: false };
  }

  // Inline content sniffing.
  if (
    (value.startsWith("{") && value.endsWith("}")) ||
    (value.startsWith("[") && value.endsWith("]"))
  ) {
    try {
      JSON.parse(value);
      return confident("json");
    } catch {
      // not JSON — keep sniffing
    }
  }

  if (
    /<([a-z!][\s\S]*?)>/i.test(value) &&
    /<\/[a-z]+>|<[a-z]+\s*\/?>/i.test(value)
  ) {
    return confident("html");
  }

  if (/^#{1,6}\s|\*\*[^*]+\*\*|^[-*]\s|\[[^\]]+\]\([^)]+\)/m.test(value)) {
    return confident("markdown");
  }

  const firstLine = value.split("\n")[0] ?? "";
  if (value.includes("\n") && firstLine.includes(",")) {
    return confident("csv");
  }

  return confident("text");
}

/** The detected source format (dropping the confidence flag). */
export const detectFormatFromHint = (input: string): Format | undefined =>
  detectFormat(input)?.format;
