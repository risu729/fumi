import { bindings, defineConfig, exports, triggers } from "cf/config";
import { loadEnv } from "vite";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
import { compatibilityDate } from "./worker-runtime.ts";

const catalogId = loadEnv("production", ".", "FUMI_CATALOG_DATABASE_ID")[
  "FUMI_CATALOG_DATABASE_ID"
];

export default defineConfig({
  worker: {
    name: "fumi",
    entrypoint,
    compatibilityDate,
    exports: {
      MailProcessing: exports.workflow({
        name: "fumi-mail-processing",
        defaultRetention: { successRetention: "3 days", errorRetention: "3 days" },
      }),
    },
    env: {
      MAIL_ARCHIVE: bindings.r2({ name: "fumi-mail" }),
      MAIL_CATALOG: bindings.d1({
        name: "fumi-catalog",
        ...(catalogId ? { id: catalogId } : {}),
      }),
      FORWARD_TO: bindings.secret(),
      MAIL_PROCESSING: bindings.workflow({
        name: "fumi-mail-processing",
        worker: "fumi",
        exportName: "MailProcessing",
      }),
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
