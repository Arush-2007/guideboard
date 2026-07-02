import { describe, expect, it } from "vitest";
import {
  csvToJson,
  htmlToText,
  jsonToCsv,
  markdownToHtml,
  parseCsv,
} from "./converters";

describe("parseCsv", () => {
  it("parses simple rows", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles quoted fields with commas, quotes, and newlines", () => {
    const csv = 'name,note\n"Ada, L","say ""hi""\nagain"';
    expect(parseCsv(csv)).toEqual([
      ["name", "note"],
      ["Ada, L", 'say "hi"\nagain'],
    ]);
  });

  it("ignores a trailing newline (no empty final row)", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("csvToJson", () => {
  it("maps headers to values", () => {
    expect(csvToJson("name,email\nAda,ada@x.com")).toEqual([
      { name: "Ada", email: "ada@x.com" },
    ]);
  });

  it("fills missing trailing cells with empty strings", () => {
    expect(csvToJson("a,b,c\n1,2")).toEqual([{ a: "1", b: "2", c: "" }]);
  });

  it("returns [] for empty input", () => {
    expect(csvToJson("   ")).toEqual([]);
  });
});

describe("jsonToCsv", () => {
  it("serializes an array of objects with a header row", () => {
    const out = jsonToCsv('[{"name":"Ada","age":36},{"name":"Bob","age":40}]');
    expect(out).toBe("name,age\nAda,36\nBob,40");
  });

  it("unions keys across rows, preserving first-seen order", () => {
    const out = jsonToCsv('[{"a":1},{"b":2}]');
    expect(out).toBe("a,b\n1,\n,2");
  });

  it("accepts a single object", () => {
    expect(jsonToCsv('{"a":1,"b":2}')).toBe("a,b\n1,2");
  });

  it("quotes values containing commas or quotes", () => {
    expect(jsonToCsv('[{"v":"a,b"}]')).toBe('v\n"a,b"');
  });

  it("throws on invalid JSON", () => {
    expect(() => jsonToCsv("not json")).toThrow(/valid JSON/);
  });

  it("throws when there are no objects to serialize", () => {
    expect(() => jsonToCsv("[1,2,3]")).toThrow(/object/);
  });
});

describe("htmlToText", () => {
  it("strips tags and decodes entities", () => {
    expect(htmlToText("<p>Hello&nbsp;<b>world</b> &amp; more</p>")).toBe(
      "Hello world & more",
    );
  });

  it("drops script/style content and converts breaks to newlines", () => {
    const html =
      "<style>x{}</style><p>one</p><p>two</p><script>evil()</script>";
    expect(htmlToText(html)).toBe("one\ntwo");
  });
});

describe("markdownToHtml", () => {
  it("renders bold and headings", () => {
    const html = markdownToHtml("# Title\n\nSome **bold** text.");
    expect(html).toContain("<h1");
    expect(html).toContain("<strong>bold</strong>");
  });
});
