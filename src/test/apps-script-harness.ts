import { createHmac } from "node:crypto";

/**
 * Runs a generated Google Apps Script the way Google would.
 *
 * The point of testing through this rather than hand-building a request: the
 * Google Form trigger shipped completely broken because its route test injected
 * the auth header itself, so it verified the route against a hypothetical
 * well-behaved caller while the script we actually generate sent no credential
 * at all. Tests that go through here execute the real generated script and
 * capture the real request it makes.
 *
 * Shared by the unit and integration suites because the load-bearing subtlety
 * below — Apps Script's SIGNED bytes — was written out twice, and a drift
 * between the two copies is precisely how a green test ends up sitting over a
 * script the live route rejects.
 *
 * Not a `.test.ts` file, so vitest does not collect it as a suite.
 */

/** The `sha256=<lowercase hex>` a correct caller sends. */
export function signBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

/**
 * The request the script made, asserting it made one.
 *
 * `runGeneratedFormScript` already rethrows when the script died before
 * reaching the fetch, so reaching the `throw` here means it returned normally
 * having sent nothing — the one remaining way `call` is null, and never
 * something a caller wants to discover as `undefined.options` further down.
 */
export function requireRequest(result: {
  call: CapturedFetch | null;
}): CapturedFetch {
  if (!result.call) {
    throw new Error("the generated script returned without sending a request");
  }
  return result.call;
}

/** The HTTP call the script made, as `UrlFetchApp.fetch` received it. */
export type CapturedFetch = {
  url: string;
  options: {
    payload: string;
    headers: Record<string, string>;
    method: string;
    contentType: string;
    muteHttpExceptions?: boolean;
  };
};

type RunOptions = {
  /** Question title -> answer, as the respondent filled the form in. */
  answers: Record<string, string>;
  responseId?: string;
  respondentEmail?: string;
  formId?: string;
  formTitle?: string;
  /** What the server answers. Non-2xx is how the throw path is exercised. */
  responseCode?: number;
  responseBody?: string;
};

/**
 * Evaluates `script`, invokes its `onFormSubmit` against a stub form event, and
 * reports what it sent and whether it threw.
 *
 * `thrown` is the assertion that matters for a rejected submission: the script
 * must throw so Apps Script marks the run failed and Google emails the form
 * owner. Swallowing it is what made this bug invisible for so long.
 *
 * `call` is null when the script made no request. If it also threw, the error
 * came from the script BEFORE it reached the fetch — a bug in what we generate
 * rather than a modelled server rejection — so that is rethrown here. Returning
 * it quietly would surface as `undefined.options` in the caller and bury the
 * real error, which is the opposite of what this harness is for.
 */
export function runGeneratedFormScript(
  script: string,
  {
    answers,
    responseId = "resp_abc",
    respondentEmail = "respondent@example.com",
    formId = "form_1",
    formTitle = "Test Form",
    responseCode = 200,
    responseBody = '{"success":true}',
  }: RunOptions,
): { call: CapturedFetch | null; thrown: Error | null } {
  let call: CapturedFetch | null = null;
  let thrown: Error | null = null;

  // Apps Script returns SIGNED bytes (-128..127). Reproducing that exactly is
  // what makes this a real test of the script's hex encoding: a script that
  // forgot to mask with 0xFF produces "-3a"-style garbage here too, and the
  // route rejects it — which is the whole point of running the real script.
  const signedBytes = (value: string, key: string, encoding: BufferEncoding) =>
    Array.from(createHmac("sha256", key).update(value, encoding).digest()).map(
      (b) => (b > 127 ? b - 256 : b),
    );

  const Utilities = {
    MacAlgorithm: { HMAC_SHA_256: "HMAC_SHA_256" },
    Charset: { UTF_8: "UTF_8", US_ASCII: "US_ASCII" },

    /**
     * The charset-explicit overload, and the only one this harness will run.
     *
     * The charset is CHECKED rather than assumed, because assuming it is what
     * would make this test a tautology: the server verifies UTF-8, so a shim
     * that silently decoded UTF-8 whatever the script asked for would report
     * agreement between the script and our model of Apps Script, not between
     * the script and the route. Any charset but UTF_8 must fail here, loudly.
     */
    computeHmacSignature: (
      algorithm: string,
      value: string,
      key: string,
      charset: string,
    ) => {
      if (algorithm !== "HMAC_SHA_256") {
        throw new Error(
          `Harness models HMAC_SHA_256 only; script asked for ${algorithm}`,
        );
      }
      if (charset !== "UTF_8") {
        throw new Error(
          `Script signed as ${charset}, but the route hashes the request body ` +
            "as UTF-8 (webhook-verify.ts). Any non-ASCII answer would 401.",
        );
      }
      return signedBytes(value, key, "utf8");
    },

    /**
     * Deliberately unusable. Apps Script really does offer this 2-argument
     * form, so refusing it is not an omission in the model — it is the harness
     * declining to certify a call whose byte encoding is unstated. A script
     * that reverts to it fails here with the reason rather than passing on
     * ASCII fixtures and rejecting a respondent named "José" in production.
     */
    computeHmacSha256Signature: () => {
      throw new Error(
        "computeHmacSha256Signature(value, key) does not state a charset. Use " +
          "computeHmacSignature(MacAlgorithm.HMAC_SHA_256, value, key, " +
          "Charset.UTF_8) so the bytes signed are the bytes the route hashes.",
      );
    },
  };

  const UrlFetchApp = {
    fetch: (url: string, options: CapturedFetch["options"]) => {
      call = { url, options };
      return {
        getResponseCode: () => responseCode,
        getContentText: () => responseBody,
      };
    },
  };

  const event = {
    response: {
      getItemResponses: () =>
        Object.entries(answers).map(([title, value]) => ({
          getItem: () => ({ getTitle: () => title }),
          getResponse: () => value,
        })),
      getId: () => responseId,
      getTimestamp: () => "2026-08-06T00:00:00.000Z",
      getRespondentEmail: () => respondentEmail,
    },
    source: { getId: () => formId, getTitle: () => formTitle },
  };

  // The script is plain `var`/`function` declarations, so evaluating it defines
  // `onFormSubmit` without side effects; we invoke it ourselves.
  const load = new Function(
    "Utilities",
    "UrlFetchApp",
    `${script}\nreturn { onFormSubmit: onFormSubmit };`,
  );

  try {
    load(Utilities, UrlFetchApp).onFormSubmit(event);
  } catch (error) {
    thrown = error as Error;
  }

  // Threw without ever calling fetch: the script broke on its own terms (a bad
  // Utilities call, a loop bound), so there is no request to hand back and the
  // error IS the result. Rethrow with context rather than let the caller trip
  // over a null `call` several lines later.
  if (call === null && thrown !== null) {
    throw new Error(
      `The generated script threw before sending anything: ${thrown.message}`,
      { cause: thrown },
    );
  }

  return { call, thrown };
}
