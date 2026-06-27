import { describe, expect, it } from "vitest";
import { renderTemplate, resolveMapping } from "./templating";

const ctx = {
  telegram: {
    text: "Hi there",
    from: { firstName: "Ada", lastName: "Lovelace" },
    contact: { phoneNumber: "+15551234567" },
  },
  http_request_n1: { httpResponse: { status: 200, data: { name: "Leanne" } } },
};

describe("renderTemplate — @<...>@ placeholders", () => {
  it("substitutes a simple path", () => {
    expect(renderTemplate("Hello @<telegram.from.firstName>@", ctx)).toBe(
      "Hello Ada",
    );
  });

  it("substitutes multiple placeholders and tolerates inner whitespace", () => {
    expect(
      renderTemplate(
        "@< telegram.from.firstName >@ @<telegram.from.lastName>@",
        ctx,
      ),
    ).toBe("Ada Lovelace");
  });

  it("resolves a missing path to an empty string", () => {
    expect(renderTemplate("[@<telegram.nope.gone>@]", ctx)).toBe("[]");
  });

  it("JSON-stringifies object values", () => {
    expect(renderTemplate("@<telegram.contact>@", ctx)).toBe(
      '{"phoneNumber":"+15551234567"}',
    );
  });

  it("coerces numbers", () => {
    expect(
      renderTemplate("status=@<http_request_n1.httpResponse.status>@", ctx),
    ).toBe("status=200");
  });

  it("does NOT collide with JSON braces (the Handlebars failure mode)", () => {
    const body =
      '{"name":"@<http_request_n1.httpResponse.data.name>@","status":@<http_request_n1.httpResponse.status>@}';
    const out = renderTemplate(body, ctx);
    expect(JSON.parse(out)).toEqual({ name: "Leanne", status: 200 });
  });

  it("returns plain text unchanged", () => {
    expect(renderTemplate("no placeholders here", ctx)).toBe(
      "no placeholders here",
    );
  });
});

describe("renderTemplate — {{...}} back-compat", () => {
  it("still renders legacy Handlebars expressions", () => {
    expect(renderTemplate("Hi {{telegram.from.firstName}}", ctx)).toBe(
      "Hi Ada",
    );
  });

  it("supports the json helper", () => {
    expect(renderTemplate("{{json telegram.contact}}", ctx)).toContain(
      '"phoneNumber": "+15551234567"',
    );
  });

  it("supports both syntaxes in one template", () => {
    expect(
      renderTemplate(
        "{{telegram.from.firstName}} / @<telegram.from.lastName>@",
        ctx,
      ),
    ).toBe("Ada / Lovelace");
  });
});

describe("resolveMapping", () => {
  it("renders each target's template against context", () => {
    const out = resolveMapping(
      {
        Name: "@<telegram.from.firstName>@ @<telegram.from.lastName>@",
        Phone: "@<telegram.contact.phoneNumber>@",
        Note: "static text",
      },
      ctx,
    );
    expect(out).toEqual({
      Name: "Ada Lovelace",
      Phone: "+15551234567",
      Note: "static text",
    });
  });
});
