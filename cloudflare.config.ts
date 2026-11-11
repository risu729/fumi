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
        concurrency: { limit: 5 },
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
      EMAIL: bindings.sendEmail(),
      ACCESS_ISSUER: bindings.secret(),
      ACCESS_AUDIENCE: bindings.secret(),
      API_ORIGIN: bindings.secret(),
      MAIL_GRANTS: bindings.secret(),
      WEBHOOK_ORIGINS: bindings.secret(),
      MAIL_PROCESSING: bindings.workflow({
        name: "fumi-mail-processing",
        worker: "fumi",
        exportName: "MailProcessing",
      }),
    },
    workersDev: false,
    previewUrls: false,
    triggers: [
      triggers.scheduled({ schedule: "*/5 * * * *" }),
      triggers.queue({
        name: "fumi-delivery-events",
        deadLetterQueue: "fumi-delivery-events-dlq",
        maxBatchSize: 10,
        maxRetries: 5,
      }),
    ],
    observability: {
      enabled: true,
      headSamplingRate: 1,
      issues: { enabled: true },
      traces: { enabled: true, headSamplingRate: 0.01 },
    },
  },
});
