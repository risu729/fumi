import { describe, expect, it } from "vitest";
import { pairBoundary, truncateCodeUnits } from "../src/utf16.ts";

describe("UTF-16 cut boundaries", () => {
  const pair = "a😀b"; // "a", high surrogate, low surrogate, "b"

  it("moves a cut back only between the halves of a real pair", () => {
    expect([0, 1, 2, 3, 4, 5].map((index) => pairBoundary(pair, index))).toEqual([
      0, 1, 1, 3, 4, 5,
    ]);
  });

  it("leaves lone surrogates that are already in the input alone", () => {
    expect(pairBoundary("a\uD83Db", 2)).toBe(2);
    expect(pairBoundary("a\uDE00b", 1)).toBe(1);
    expect(pairBoundary("\uDE00\uD83D", 1)).toBe(1);
  });

  it("truncates without leaving half a pair", () => {
    expect(truncateCodeUnits(pair, 2)).toBe("a");
    expect(truncateCodeUnits(pair, 3)).toBe("a😀");
    expect(truncateCodeUnits(pair, 10)).toBe(pair);
    expect(truncateCodeUnits(pair, 0)).toBe("");
  });
});
