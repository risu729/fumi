import { describe, expect, it } from "vitest";
import { routingRpcOptions } from "../routing-rpc-options.ts";

describe("optional trusted routing RPC binding", () => {
  it("omits the capability when both deployment values are absent or empty", () => {
    expect(routingRpcOptions({})).toBeNull();
    expect(
      routingRpcOptions({ FUMI_ROUTING_RPC_WORKER: "", FUMI_ROUTING_RPC_ENTRYPOINT: "" }),
    ).toBeNull();
  });
  it("selects only the administrator-named worker and entrypoint", () => {
    expect(
      routingRpcOptions({
        FUMI_ROUTING_RPC_WORKER: "synthetic-routing-owner",
        FUMI_ROUTING_RPC_ENTRYPOINT: "SyntheticOffer",
      }),
    ).toEqual({ worker: "synthetic-routing-owner", exportName: "SyntheticOffer" });
  });
  it.each([
    { FUMI_ROUTING_RPC_WORKER: "synthetic-routing-owner" },
    { FUMI_ROUTING_RPC_ENTRYPOINT: "SyntheticOffer" },
    {
      FUMI_ROUTING_RPC_WORKER: "https://untrusted.invalid",
      FUMI_ROUTING_RPC_ENTRYPOINT: "SyntheticOffer",
    },
    {
      FUMI_ROUTING_RPC_WORKER: "synthetic-routing-owner",
      FUMI_ROUTING_RPC_ENTRYPOINT: "Owner/Offer",
    },
    {
      FUMI_ROUTING_RPC_WORKER: " synthetic-routing-owner",
      FUMI_ROUTING_RPC_ENTRYPOINT: "SyntheticOffer",
    },
    { FUMI_ROUTING_RPC_WORKER: "x".repeat(64), FUMI_ROUTING_RPC_ENTRYPOINT: "SyntheticOffer" },
    {
      FUMI_ROUTING_RPC_WORKER: "synthetic-routing-owner",
      FUMI_ROUTING_RPC_ENTRYPOINT: "X".repeat(129),
    },
  ])("rejects partial or invalid configuration %#", (values) => {
    expect(() => routingRpcOptions(values)).toThrow("Invalid paired routing RPC configuration");
  });
});
