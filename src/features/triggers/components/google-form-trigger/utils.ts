/**
 * The Apps Script a user pastes into their Google Form to connect it.
 *
 * Two things here are load-bearing, and the trigger was fully broken in
 * production for want of the first:
 *
 * 1. **It authenticates.** The script posts to a per-workflow token URL and
 *    signs the exact body it sends with HMAC-SHA256. The previous version set no
 *    headers and no `?secret=`, so it presented no credential at all — the
 *    receiving route demanded one and rejected every submission. That was
 *    invisible for as long as the route treated an unset secret as "allow".
 *
 * 2. **It fails loudly.** The previous version wrapped the POST in
 *    `try { … } catch { console.error(…) }` and called `fetch` without
 *    `muteHttpExceptions`, so a rejected submission was swallowed: the form
 *    owner saw a normal submission, the workflow never ran, and nothing anywhere
 *    said so. It took a client reporting silence to find it. Now a non-2xx
 *    throws, which marks the run failed in the Apps Script dashboard AND makes
 *    Google email the form owner its trigger-failure notice.
 */

export const generateGoogleFormScript = (
  webhookUrl: string,
  signingSecret: string,
) => `var WEBHOOK_URL = '${webhookUrl}';
// Signs each submission so Guideboard can verify it came from this form.
// Treat it like a password: anyone with it can post to your workflow.
var SIGNING_SECRET = '${signingSecret}';

// Run this ONCE (Run ▸ setup) to connect the form — no manual trigger needed.
function setup() {
  var form = FormApp.getActiveForm();
  // Avoid duplicate triggers if setup is run more than once.
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'onFormSubmit') {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }
  ScriptApp.newTrigger('onFormSubmit').forForm(form).onFormSubmit().create();
}

// HMAC-SHA256 of the body, lowercase hex, 'sha256=' prefixed — the format
// Guideboard verifies. Signed over the EXACT string that is sent as the
// payload; re-serializing the object here would change bytes and fail.
function signBody(body) {
  var bytes = Utilities.computeHmacSha256Signature(body, SIGNING_SECRET);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    // Apps Script bytes are SIGNED (-128..127); the & 0xFF is what turns a
    // negative byte into the 0..255 value its hex pair represents.
    var b = (bytes[i] & 0xFF).toString(16);
    if (b.length === 1) b = '0' + b;
    hex += b;
  }
  return 'sha256=' + hex;
}

function onFormSubmit(e) {
  var formResponse = e.response;
  var itemResponses = formResponse.getItemResponses();

  // Build responses object, keyed by question title TRIMMED — the reference
  // paths Guideboard offers are built from the trimmed title, so a question
  // titled with a stray space would otherwise emit an unreachable key.
  // (The receiving webhook trims too, so already-connected forms are fine.)
  var responses = {};
  for (var i = 0; i < itemResponses.length; i++) {
    var itemResponse = itemResponses[i];
    var title = String(itemResponse.getItem().getTitle()).trim();
    if (title) responses[title] = itemResponse.getResponse();
  }

  var payload = JSON.stringify({
    formId: e.source.getId(),
    formTitle: e.source.getTitle(),
    responseId: formResponse.getId(),
    timestamp: formResponse.getTimestamp(),
    respondentEmail: formResponse.getRespondentEmail(),
    responses: responses
  });

  var response = UrlFetchApp.fetch(WEBHOOK_URL, {
    'method': 'post',
    'contentType': 'application/json',
    'payload': payload,
    'headers': { 'X-Guideboard-Signature': signBody(payload) },
    // Read the status ourselves rather than letting a non-2xx throw an opaque
    // exception — we want the server's message in the log, not just a code.
    'muteHttpExceptions': true
  });

  var code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    // THROW, don't swallow. This marks the run failed in Apps Script's
    // execution log and triggers Google's failure email to the form owner, so a
    // form that has silently stopped starting workflows announces itself.
    throw new Error(
      'Guideboard rejected this submission (HTTP ' + code + '): ' +
      response.getContentText()
    );
  }
}`;
