import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { runTakeoutChunk, takeoutConfig } from "./gmail-takeout-import.ts";
import { GmailImportError } from "./gmail-transport.ts";

/** Chunks one Workflow instance runs before the cron starts a fresh one. */
const MAX_CHUNKS = 2000;
const retry: WorkflowStepConfig = {
  retries: { limit: 5, delay: "30 seconds", backoff: "exponential" },
  timeout: "15 minutes",
};

/**
 * Drives one configured Takeout run (ADR 0004) chunk by chunk. Progress lives in D1,
 * so a replacement instance continues from the run's checkpoint.
 */
export class TakeoutImport extends WorkflowEntrypoint<Env, { runId: string }> {
  override async run(event: WorkflowEvent<{ runId: string }>, step: WorkflowStep) {
    for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
      // oxlint-disable-next-line no-await-in-loop -- Chunks advance one checkpoint in order.
      const result = await step.do(`chunk-${chunk}`, retry, async () => {
        try {
          const config = takeoutConfig(this.env);
          if (!config || config.runId !== event.payload.runId)
            throw new NonRetryableError("Takeout run is no longer configured");
          return await runTakeoutChunk(this.env, config);
        } catch (error) {
          if (error instanceof NonRetryableError) throw error;
          // Only fixed codes leave the step: causes can hold SQL parameters or object keys.
          const code = error instanceof GmailImportError ? error.code : "takeout_import_failed";
          if (code === "takeout_config_conflict" || code === "invalid_takeout_configuration")
            throw new NonRetryableError(code);
          // oxlint-disable-next-line preserve-caught-error -- Causes can contain mail and SQL parameters.
          throw new Error(code);
        }
      });
      if (result.status === "busy")
        // oxlint-disable-next-line no-await-in-loop -- Another runner holds the lease; wait for it.
        await step.sleep(`busy-${chunk}`, "2 minutes");
      else if (result.status !== "advanced") return result;
    }
    return { status: "chunk_limit" };
  }
}
