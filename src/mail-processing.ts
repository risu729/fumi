import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  beginProcessing,
  completeProcessing,
  failProcessing,
  parseProcessingParams,
  processingInstanceId,
  readProcessingJob,
} from "./processing-jobs.ts";
import { indexArchiveSource } from "./reconcile.ts";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import type { ProcessingParams } from "./processing-jobs.ts";

const retry: WorkflowStepConfig = {
  retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
  timeout: "1 minute",
};

// Service errors may contain SQL parameters or object metadata. Persist/log only
// fixed diagnostics in Workflows, while its engine owns retries and checkpoints.
async function redacted<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new Error("Mail processing step failed");
  }
}

export class MailProcessing extends WorkflowEntrypoint<Env, ProcessingParams> {
  override async run(event: WorkflowEvent<ProcessingParams>, step: WorkflowStep) {
    const params = parseProcessingParams(event.payload);
    if (!params || event.instanceId !== processingInstanceId(params.rawKey, params.attempt)) {
      throw new NonRetryableError("Invalid mail processing identity");
    }
    const session = this.env.MAIL_CATALOG.withSession("first-primary");
    try {
      const active = await step.do("begin-catalog-v1", retry, () =>
        redacted(() => beginProcessing(session, params)),
      );
      if (!active) return { status: "skipped" };
      const result = await step.do("index-catalog-v1", retry, () =>
        redacted(async () => {
          const current = await readProcessingJob(
            this.env.MAIL_CATALOG.withSession("first-primary"),
            params.rawKey,
          );
          if (current?.instance_id !== event.instanceId || current.state !== "running") {
            throw new Error("Processing attempt is no longer active");
          }
          return indexArchiveSource(
            this.env.MAIL_ARCHIVE,
            this.env.MAIL_CATALOG,
            params.rawKey,
            event.instanceId,
          );
        }),
      );
      await step.do("complete-catalog-v1", retry, () =>
        redacted(() => completeProcessing(session, params)),
      );
      return { status: "cataloged", ...result };
    } catch {
      await step.do("record-catalog-failure-v1", retry, () =>
        redacted(() => failProcessing(session, params)),
      );
      throw new NonRetryableError("Mail catalog processing failed");
    }
  }
}
