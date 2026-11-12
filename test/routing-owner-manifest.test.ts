import { afterEach, describe, expect, it, vi } from "vitest";
import { readRoutingOwnerManifest } from "../src/routing-owner-manifest.ts";
import { dispatchDigest } from "../src/plugin-offer.ts";

const json = JSON.stringify(
  {
    schemaVersion: 1,
    pluginId: "synthetic-owner",
    version: "1.0.0",
    protocol: "fumi-offer-v1",
    mode: "exclusive",
    inputFields: ["subject"],
    offerInputFields: ["subject", "envelope", "text"],
    capabilities: ["offer"],
    match: 'subject == "Synthetic"',
  },
  null,
  2,
);
afterEach(() => vi.useRealTimers());
describe("read-only default owner publication", () => {
  it("preserves exact publication bytes and receiver while attesting only the fixed capability", async () => {
    const publication = { json, sha256: await dispatchDigest(json) };
    const binding = {
      publication,
      async manifest() {
        return this.publication;
      },
      offer: vi.fn(),
      receipt: vi.fn(),
    };
    const response = await readRoutingOwnerManifest(binding);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...publication,
      binding: { kind: "rpc", serviceRef: "default", name: "ROUTING_DISPATCH_RPC" },
    });
    expect(binding.offer).not.toHaveBeenCalled();
    expect(binding.receipt).not.toHaveBeenCalled();
  });
  it("reports an absent optional binding or method without attempting a fallback", async () => {
    expect((await readRoutingOwnerManifest(undefined)).status).toBe(503);
    expect((await readRoutingOwnerManifest({})).status).toBe(503);
  });
  it.each(["hash", "schema", "cel", "utf8", "shape", "exception"] as const)(
    "redacts %s publication failures",
    async (kind) => {
      const body =
        kind === "schema"
          ? json.replace('"fumi-offer-v1"', '"invalid"')
          : kind === "cel"
            ? JSON.stringify({ ...JSON.parse(json), match: 'subject.matches(".*")' })
            : kind === "utf8"
              ? JSON.stringify({ ...JSON.parse(json), match: `subject == "${"あ".repeat(2900)}"` })
              : json;
      const response = await readRoutingOwnerManifest({
        async manifest() {
          if (kind === "exception") throw new Error("private-provider-detail");
          return {
            json: body,
            sha256: kind === "hash" ? "0".repeat(64) : await dispatchDigest(body),
            ...(kind === "shape" ? { private: "private-provider-detail" } : {}),
          };
        },
      });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: { code: "owner_manifest_unavailable" } });
    },
  );
  it("bounds a permanently stalled owner to the fixed shared deadline", async () => {
    vi.useFakeTimers();
    const pending = readRoutingOwnerManifest({ manifest: () => new Promise(() => undefined) });
    await vi.advanceTimersByTimeAsync(5000);
    expect((await pending).status).toBe(502);
  });
});
