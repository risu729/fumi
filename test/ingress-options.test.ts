import { describe, expect, it } from "vitest";
import { ingressMode } from "../ingress-options.ts";

describe("trusted ingress mode", () => {
  it("preserves forwarding by default and admits only an explicit archive-only mode", () => {
    expect(ingressMode(undefined)).toBe("forward");
    expect(ingressMode("forward")).toBe("forward");
    expect(ingressMode("archive-only")).toBe("archive-only");
  });
  it.each(["", "false", "0", "archive", "archive-only ", "ARCHIVE-ONLY"])(
    "rejects ambiguous configuration %s",
    (value) => expect(() => ingressMode(value)).toThrow("Invalid ingress mode"),
  );
});
