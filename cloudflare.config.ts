import { bindings, defineConfig, exports, triggers } from "cf/config";
import { loadEnv } from "vite";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
import { compatibilityDate } from "./worker-runtime.ts";
import { routingRpcOptions } from "./routing-rpc-options.ts";

const catalogId = loadEnv("production", ".", "FUMI_CATALOG_DATABASE_ID")[
  "FUMI_CATALOG_DATABASE_ID"
];
const optional = loadEnv("production", ".", "FUMI_");
const pdfParser = optional["FUMI_PDF_PARSER_ENABLED"] === "1";
const documents = optional["FUMI_DOCUMENT_CONVERSION_ENABLED"] === "1";
const ocrInstance = optional["FUMI_ATTACHMENT_OCR_INSTANCE"];
const searchInstance = optional["FUMI_MANAGED_SEARCH_INSTANCE"];
const routingRpc = routingRpcOptions(optional);
for (const name of [ocrInstance, searchInstance]) {
  if (name && !/^[a-z0-9_]+(?:-[a-z0-9_]+)*$/.test(name))
    throw new Error("Invalid managed search instance name");
}

export default defineConfig({
  worker: {
    name: "fumi",
    entrypoint,
    compatibilityDate,
    domains: ["fumi.takuk.me"],
    exports: {
      MailProcessing: exports.workflow({
        name: "fumi-mail-processing",
        concurrency: { limit: 25 },
        defaultRetention: { successRetention: "3 days", errorRetention: "3 days" },
      }),
    },
    env: {
      ...(routingRpc
        ? {
            ROUTING_DISPATCH_RPC: bindings.worker(routingRpc),
            ROUTING_DISPATCH_RPC_IDENTITY: bindings.text(
              JSON.stringify([routingRpc.worker, routingRpc.exportName]),
            ),
          }
        : {}),
      ...(pdfParser ? { PDF_LOADER: bindings.workerLoader() } : {}),
      ...(documents ? { AI: bindings.ai() } : {}),
      ...(ocrInstance ? { ATTACHMENT_OCR: bindings.aiSearch({ name: ocrInstance }) } : {}),
      ...(searchInstance
        ? { MANAGED_MAIL_SEARCH: bindings.aiSearch({ name: searchInstance }) }
        : {}),
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
      // GMAIL_IMPORT_CONFIG/GMAIL_IMPORT_ACCESS_TOKEN remain optional runtime secrets.
      // cf secret declarations mark credentials required; optional Env types live
      // in gmail-import-http.ts so deployment does not require import activation.
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
