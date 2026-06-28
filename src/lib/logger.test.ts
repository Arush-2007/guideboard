import * as Sentry from "@sentry/nextjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "./logger";

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

const originalNodeEnv = process.env.NODE_ENV;

function setNodeEnv(value: string) {
  // NODE_ENV is typed readonly; assign through the record to flip it per test.
  (process.env as Record<string, string>).NODE_ENV = value;
}

describe("logger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    setNodeEnv(originalNodeEnv ?? "test");
    vi.restoreAllMocks();
  });

  describe("in production", () => {
    beforeEach(() => setNodeEnv("production"));

    it("forwards error with the exception to Sentry.captureException", () => {
      const err = new Error("boom");
      logger.error("failed to do thing", err, { nodeId: "n1" });

      expect(Sentry.captureException).toHaveBeenCalledWith(err, {
        extra: { logMessage: "failed to do thing", nodeId: "n1" },
      });
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalled();
    });

    it("forwards a bare error (no exception) as captureMessage", () => {
      logger.error("just a message");

      expect(Sentry.captureMessage).toHaveBeenCalledWith("just a message", {
        level: "error",
        extra: undefined,
      });
      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    it("forwards warn to Sentry.captureMessage at warning level", () => {
      logger.warn("heads up", { foo: 1 });

      expect(Sentry.captureMessage).toHaveBeenCalledWith("heads up", {
        level: "warning",
        extra: { foo: 1 },
      });
    });

    it("suppresses debug", () => {
      logger.debug("noisy");
      expect(console.debug).not.toHaveBeenCalled();
    });
  });

  describe("outside production", () => {
    beforeEach(() => setNodeEnv("development"));

    it("logs error to console without touching Sentry", () => {
      logger.error("failed", new Error("x"));
      expect(console.error).toHaveBeenCalled();
      expect(Sentry.captureException).not.toHaveBeenCalled();
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it("logs warn to console without touching Sentry", () => {
      logger.warn("careful");
      expect(console.warn).toHaveBeenCalled();
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it("emits debug", () => {
      logger.debug("trace");
      expect(console.debug).toHaveBeenCalled();
    });
  });
});
