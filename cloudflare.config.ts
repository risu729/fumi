import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
import { compatibilityDate } from "./worker-runtime.ts";

export default defineConfig({
  worker: {
    name: "fumi",
    entrypoint,
    compatibilityDate,
    env: {
      MAIL_ARCHIVE: bindings.r2({ name: "fumi-mail" }),
      FORWARD_TO: bindings.secret(),
    },
    workersDev: false,
    previewUrls: false,
    observability: {
      enabled: true,
      headSamplingRate: 1,
      traces: { enabled: true, headSamplingRate: 0.01 },
    },
  },
});
