import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import {
  PST_FAILURE_CODES,
  PstImportError,
  pstConfig,
  runPstChunk,
  stopPstRun,
} from "./pst-import.ts";

/** Chunks one Workflow instance runs before the cron starts a fresh one. */
const MAX_CHUNKS = 2000;
const retry: WorkflowStepConfig = {
  retries: { limit: 5, delay: "30 seconds", backoff: "exponential" },
  timeout: "15 minutes",
};

const CONFIGURATION_CODES = new Set([
  "pst_not_configured",
  "pst_config_conflict",
  "invalid_pst_configuration",
]);

/** Only fixed codes leave a step: causes can hold SQL parameters or object keys. */
export function pstStepError(error: unknown): Error {
  if (error instanceof NonRetryableError) return error;
  const code = error instanceof PstImportError ? error.code : "pst_import_failed";
  if (CONFIGURATION_CODES.has(code)) return new NonRetryableError(code);
  return new Error(PST_FAILURE_CODES.has(code) ? code : "pst_import_failed");
}

/**
 * Drives one configured PST run (ADR 0006) chunk by chunk. Progress lives in D1, so a
 * replacement instance continues from the run's checkpoint.
 */
export class PstImport extends WorkflowEntrypoint<Env, { runId: string }> {
  override async run(event: WorkflowEvent<{ runId: string }>, step: WorkflowStep) {
    for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
      let result;
      try {
        // oxlint-disable-next-line no-await-in-loop -- Chunks advance one checkpoint in order.
        result = await step.do(`chunk-${chunk}`, retry, async () => {
          try {
            const config = pstConfig(this.env);
            if (!config || config.runId !== event.payload.runId)
              throw new NonRetryableError("pst_not_configured");
            return await runPstChunk(this.env, config);
          } catch (error) {
            throw pstStepError(error);
          }
        });
      } catch (error) {
        const code = error instanceof Error ? error.message : "pst_import_failed";
        // A removed or changed configuration is the operator's doing; leave the run as is.
        if (CONFIGURATION_CODES.has(code)) throw pstStepError(error);
        // Every retry failed: record the fixed code so the cron does not restart forever.
        // oxlint-disable-next-line no-await-in-loop -- Runs once, as the instance ends.
        await step.do(`stop-${chunk}`, retry, () =>
          stopPstRun(this.env.MAIL_CATALOG, event.payload.runId, event.instanceId, code),
        );
        throw pstStepError(error);
      }
      if (result.status === "busy")
        // oxlint-disable-next-line no-await-in-loop -- Another runner holds the lease; wait for it.
        await step.sleep(`busy-${chunk}`, "2 minutes");
      else if (result.status !== "advanced") return result;
    }
    return { status: "chunk_limit" };
  }
}
