/**
 * Fetches a resume from a URL and returns its plain text, used by the
 * `RESUME_PARSER` node's built-in provider. Isolated from the executor (and the
 * pure `resume-fields.ts` heuristics) so the per-host auth + format handling has
 * one home and can evolve independently.
 *
 * Format: PDFs are detected by content-type or the `%PDF` magic bytes and
 * extracted with `unpdf` (pure-JS, serverless-friendly); anything else is
 * decoded as UTF-8 text. Google Drive share links are rewritten to a direct
 * download URL; a private Drive file additionally needs the caller's Google
 * access token (the user already holds the Drive OAuth scope).
 */

import { extractText, getDocumentProxy } from "unpdf";

export type FetchedResume = {
  text: string;
  /** "pdf" | "text" — how the bytes were interpreted. */
  kind: "pdf" | "text";
  byteLength: number;
};

const PDF_MAGIC = "%PDF";

// A Google Drive file ID: 25+ chars of URL-safe base64, no scheme/dots/slashes.
// Google Forms file-upload answers are bare IDs of this shape.
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{25,}$/;

/**
 * Unwraps a Google Forms file-upload answer. Those arrive as an array of Drive
 * file IDs which `renderTemplate` stringifies into the JSON literal `["<id>"]`,
 * so we parse it and take the first entry. Anything else passes through.
 */
function unwrapFormUpload(url: string): string {
  const s = url.trim();
  if (s.startsWith("[")) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr) && typeof arr[0] === "string") {
        return arr[0].trim();
      }
    } catch {
      // not valid JSON — fall through and use the raw string
    }
  }
  return s;
}

/**
 * Rewrites a resume source into a direct-download URL. Handles Drive share/view
 * links, Google Forms file-upload answers (a `["<fileId>"]` array or a bare file
 * ID), and passes plain URLs through untouched.
 */
export function normalizeResumeUrl(url: string): string {
  const raw = unwrapFormUpload(url);
  const driveFile = raw.match(/drive\.google\.com\/file\/d\/([^/]+)/);
  if (driveFile?.[1]) {
    return `https://www.googleapis.com/drive/v3/files/${driveFile[1]}?alt=media`;
  }
  const driveOpen = raw.match(/drive\.google\.com\/open\?id=([^&]+)/);
  if (driveOpen?.[1]) {
    return `https://www.googleapis.com/drive/v3/files/${driveOpen[1]}?alt=media`;
  }
  // A bare Drive file ID (Google Forms upload) -> direct download URL.
  if (DRIVE_ID_RE.test(raw)) {
    return `https://www.googleapis.com/drive/v3/files/${raw}?alt=media`;
  }
  return raw;
}

/**
 * Whether a source is (or resolves to) a Google Drive file, i.e. needs the
 * user's Google access token to download. Covers Drive URLs, a bare file ID,
 * and the Google Forms `["<fileId>"]` upload shape.
 */
export function isDriveSource(url: string): boolean {
  const raw = unwrapFormUpload(url);
  return (
    /drive\.google\.com|googleapis\.com\/drive/.test(raw) ||
    DRIVE_ID_RE.test(raw)
  );
}

function looksLikePdf(bytes: Uint8Array, contentType: string | null): boolean {
  if (contentType?.toLowerCase().includes("application/pdf")) return true;
  const head = new TextDecoder().decode(bytes.slice(0, 5));
  return head.startsWith(PDF_MAGIC);
}

async function pdfToText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join("\n") : text;
}

/**
 * Downloads `url` and returns its text. `accessToken` (a Google OAuth token) is
 * sent as a Bearer header — required for private Drive files, harmless for
 * public URLs. Uses the global `fetch` so it runs in any (edge/node) runtime.
 */
export async function fetchResumeText(
  url: string,
  opts: { accessToken?: string } = {},
): Promise<FetchedResume> {
  const target = normalizeResumeUrl(url);
  const headers: Record<string, string> = {};
  if (opts.accessToken) headers.Authorization = `Bearer ${opts.accessToken}`;

  const res = await fetch(target, { headers });
  if (!res.ok) {
    throw new Error(
      `Resume fetch failed: ${res.status} ${res.statusText} for ${target}`,
    );
  }

  const buffer = new Uint8Array(await res.arrayBuffer());
  const contentType = res.headers.get("content-type");

  if (looksLikePdf(buffer, contentType)) {
    return {
      text: await pdfToText(buffer),
      kind: "pdf",
      byteLength: buffer.byteLength,
    };
  }
  return {
    text: new TextDecoder().decode(buffer),
    kind: "text",
    byteLength: buffer.byteLength,
  };
}
