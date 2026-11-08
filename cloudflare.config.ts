import { bindings, defineConfig, triggers } from "cf/config";
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
    env: {
      MAIL_ARCHIVE: bindings.r2({ name: "fumi-mail" }),
      MAIL_CATALOG: bindings.d1({
        name: "fumi-catalog",
        ...(catalogId ? { id: catalogId } : {}),
      }),
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
