import { bindings, defineConfig, exports } from "cf/config";
import { loadEnv } from "vite";
import * as entrypoint from "./receiver.ts" with { type: "cf-worker" };
import { compatibilityDate } from "../../worker-runtime.ts";

// Temporary MCP Events acceptance receiver. The hostname is supplied only at
// deployment time so the endpoint is not committed.
const hostname = loadEnv("production", ".", "FUMI_EVENTS_")["FUMI_EVENTS_RECEIVER_HOSTNAME"];
if (hostname !== undefined && !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(hostname))
  throw new Error("Invalid receiver hostname");

export default defineConfig({
  worker: {
    name: "fumi-events-check",
    entrypoint,
    compatibilityDate,
    ...(hostname ? { domains: [hostname] } : {}),
    exports: {
      Results: exports.durableObject({ storage: "sqlite" }),
    },
    env: {
      RESULTS: bindings.durableObject({ worker: "fumi-events-check", exportName: "Results" }),
      SIGNING_SECRETS: bindings.secret(),
      READ_TOKEN: bindings.secret(),
    },
    workersDev: false,
    previewUrls: false,
  },
});
