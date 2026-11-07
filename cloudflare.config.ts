import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
import { compatibilityDate } from "./worker-runtime.ts";

export default defineConfig({
  worker: {
    name: "fumi",
    entrypoint,
    compatibilityDate,
    env: {
      MAIL_ARCHIVE: bindings.r2({ name: "fumi-mail" }),
      MAIL_CATALOG: bindings.d1({ name: "fumi-catalog" }),
      FORWARD_TO: bindings.secret(),
    },
    workersDev: false,
    previewUrls: false,
    triggers: [triggers.scheduled({ schedule: "*/5 * * * *" })],
    observability: {
      enabled: true,
      headSamplingRate: 1,
      traces: { enabled: true, headSamplingRate: 0.01 },
    },
  },
});
