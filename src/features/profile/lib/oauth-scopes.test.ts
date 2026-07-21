import { describe, expect, it } from "vitest";
import { describeScopes } from "./oauth-scopes";

describe("describeScopes", () => {
  it("names the scopes that power nodes", () => {
    expect(
      describeScopes([
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/gmail.modify",
      ]),
    ).toEqual(["Google Sheets", "Gmail"]);
  });

  it("collapses scopes that mean the same thing to the user", () => {
    expect(describeScopes(["email", "user:email"])).toEqual(["Email address"]);
  });

  it("shows an unmapped scope rather than hiding it", () => {
    expect(
      describeScopes(["https://www.googleapis.com/auth/calendar.events"]),
    ).toEqual(["calendar.events"]);
    expect(describeScopes(["repo"])).toEqual(["repo"]);
  });

  it("ignores empties and whitespace from a split scope string", () => {
    expect(describeScopes(["", "  ", " openid "])).toEqual(["Sign in"]);
  });

  it("returns nothing for no scopes", () => {
    expect(describeScopes([])).toEqual([]);
  });
});
