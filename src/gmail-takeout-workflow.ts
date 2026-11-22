import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import {
  runTakeoutChunk,
  stopTakeoutRun,
  takeoutConfig,
  TAKEOUT_FAILURE_CODES,
} from "./gmail-takeout-import.ts";
import { GmailImportError } from "./gmail-transport.ts";

/** Chunks one Workflow instance runs before the cron starts a fresh one. */
const MAX_CHUNKS = 2000;
const retry: WorkflowStepConfig = {
  retries: { limit: 5, delay: "30 seconds", backoff: "exponential" },
  timeout: "15 minutes",
};

const CONFIGURATION_CODES = new Set([
  "takeout_not_configured",
  "takeout_config_conflict",
  "invalid_takeout_configuration",
]);

/** Only fixed codes leave a step: causes can hold SQL parameters or object keys. */
export function takeoutStepError(error: unknown): Error {
  if (error instanceof NonRetryableError) return error;
  const code = error instanceof GmailImportError ? error.code : "takeout_import_failed";
  if (CONFIGURATION_CODES.has(code)) return new NonRetryableError(code);
  return new Error(TAKEOUT_FAILURE_CODES.has(code) ? code : "takeout_import_failed");
}

/**
 * Drives one configured Takeout run (ADR 0004) chunk by chunk. Progress lives in D1,
 * so a replacement instance continues from the run's checkpoint.
 */
export class TakeoutImport extends WorkflowEntrypoint<Env, { runId: string }> {
  override async run(event: WorkflowEvent<{ runId: string }>, step: WorkflowStep) {
    for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
      let result;
      try {
        // oxlint-disable-next-line no-await-in-loop -- Chunks advance one checkpoint in order.
        result = await step.do(`chunk-${chunk}`, retry, async () => {
          try {
            const config = takeoutConfig(this.env);
            if (!config || config.runId !== event.payload.runId)
              throw new NonRetryableError("takeout_not_configured");
            return await runTakeoutChunk(this.env, config);
          } catch (error) {
            throw takeoutStepError(error);
          }
        });
      } catch (error) {
        const code = error instanceof Error ? error.message : "takeout_import_failed";
        // A removed or changed configuration is the operator's doing; leave the run as is.
        if (CONFIGURATION_CODES.has(code)) throw takeoutStepError(error);
        // Every retry failed: record the fixed code so the cron does not restart forever.
        // oxlint-disable-next-line no-await-in-loop -- Runs once, as the instance ends.
        await step.do(`stop-${chunk}`, retry, () =>
          stopTakeoutRun(this.env.MAIL_CATALOG, event.payload.runId, code),
        );
        throw takeoutStepError(error);
      }
      if (result.status === "busy")
        // oxlint-disable-next-line no-await-in-loop -- Another runner holds the lease; wait for it.
        await step.sleep(`busy-${chunk}`, "2 minutes");
      else if (result.status !== "advanced") return result;
    }
    return { status: "chunk_limit" };
  }
}
