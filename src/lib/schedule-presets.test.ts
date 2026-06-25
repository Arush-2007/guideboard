import { describe, expect, it } from "vitest";
import {
  buildCron,
  cronToPreset,
  describeSchedule,
  type SchedulePreset,
} from "./schedule-presets";

describe("buildCron", () => {
  it("builds hourly / daily / weekly crons", () => {
    expect(buildCron({ kind: "hourly", minute: 30 })).toBe("30 * * * *");
    expect(buildCron({ kind: "daily", hour: 9, minute: 0 })).toBe("0 9 * * *");
    expect(
      buildCron({ kind: "weekly", weekday: 1, hour: 17, minute: 45 }),
    ).toBe("45 17 * * 1");
  });

  it("clamps out-of-range values into valid cron fields", () => {
    expect(buildCron({ kind: "daily", hour: 99, minute: -5 })).toBe(
      "0 23 * * *",
    );
    expect(buildCron({ kind: "weekly", weekday: 9, hour: 0, minute: 0 })).toBe(
      "0 0 * * 6",
    );
  });

  it("passes custom crons through trimmed", () => {
    expect(buildCron({ kind: "custom", cron: "  */10 * * * *  " })).toBe(
      "*/10 * * * *",
    );
  });
});

describe("cronToPreset round-trips buildCron output", () => {
  const cases: SchedulePreset[] = [
    { kind: "hourly", minute: 0 },
    { kind: "hourly", minute: 30 },
    { kind: "daily", hour: 9, minute: 0 },
    { kind: "weekly", weekday: 1, hour: 17, minute: 45 },
  ];

  for (const preset of cases) {
    it(`${JSON.stringify(preset)}`, () => {
      expect(cronToPreset(buildCron(preset))).toEqual(preset);
    });
  }

  it("falls back to custom for hand-written advanced crons", () => {
    expect(cronToPreset("*/10 9-17 * * 1-5")).toEqual({
      kind: "custom",
      cron: "*/10 9-17 * * 1-5",
    });
  });
});

describe("describeSchedule", () => {
  it("renders friendly summaries", () => {
    expect(describeSchedule({ kind: "daily", hour: 9, minute: 0 }, "UTC")).toBe(
      "Every day at 09:00 (UTC)",
    );
    expect(
      describeSchedule(
        { kind: "weekly", weekday: 1, hour: 17, minute: 5 },
        "America/New_York",
      ),
    ).toBe("Every Monday at 17:05 (America/New_York)");
  });
});
