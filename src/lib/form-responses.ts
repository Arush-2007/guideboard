/**
 * Normalizes a form webhook's `responses` map so its KEYS match the reference
 * paths the variable picker offers.
 *
 * The two halves of the contract disagreed: `getGoogleFormQuestions` builds each
 * discovered path from the question title **trimmed**, while the Apps Script
 * keys `responses` by the **raw** title (`getItem().getTitle()`). A question
 * whose title carries a stray space — "Vehicle Name or Model " — therefore
 * produced a key that no reference could ever resolve, and the mapped column
 * silently rendered empty while the answer sat right there in the payload.
 *
 * Normalizing on INGEST fixes every already-connected form at once, with no need
 * for users to re-paste the script into their form. The untouched payload is
 * still kept alongside as `raw`.
 */
export function normalizeResponseKeys(
  responses: unknown,
): Record<string, unknown> {
  if (!responses || typeof responses !== "object" || Array.isArray(responses)) {
    return {};
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(
    responses as Record<string, unknown>,
  )) {
    const trimmed = key.trim();
    if (!trimmed) continue;

    // Two titles that differ only by whitespace collapse onto one key. Keep the
    // first answer that isn't blank so a stray duplicate can never wipe a real
    // one (order is the payload's, which is the form's question order).
    const existing = out[trimmed];
    const existingIsBlank =
      existing === undefined || existing === null || existing === "";
    if (existingIsBlank) out[trimmed] = value;
  }
  return out;
}
