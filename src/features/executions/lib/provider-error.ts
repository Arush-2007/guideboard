/**
 * Turns an AI provider failure into an Error whose message carries the HTTP
 * status and the provider's own error text, instead of just the bare status
 * line (e.g. "Forbidden").
 *
 * The Vercel AI SDK throws an `AI_APICallError` carrying `statusCode` and the
 * raw `responseBody`. That body is usually JSON like
 * `{"error":{"message":"Access denied. Please check your network settings."}}`,
 * so we surface that message. Anything that isn't an API-call error is returned
 * unchanged so config/validation failures keep their original message.
 */
type ApiCallErrorish = {
  statusCode?: number;
  responseBody?: string;
  message?: string;
};

function isApiCallError(error: unknown): error is ApiCallErrorish {
  return (
    typeof error === "object" &&
    error !== null &&
    ("responseBody" in error || "statusCode" in error)
  );
}

function extractDetail(body: string, fallback: string): string {
  try {
    const parsed = JSON.parse(body);
    return parsed?.error?.message ?? parsed?.message ?? body;
  } catch {
    return body || fallback;
  }
}

export function describeProviderError(error: unknown, provider: string): Error {
  if (isApiCallError(error)) {
    const status = error.statusCode ?? "error";
    const fallback = error.message ?? "Request failed";
    const detail = error.responseBody
      ? extractDetail(error.responseBody, fallback)
      : fallback;
    return new Error(`${provider} ${status}: ${detail}`, { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
}
