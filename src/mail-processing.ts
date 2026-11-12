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
import { extractArchiveMail } from "./mime-extraction.ts";
import { dispatchRoutingSource } from "./routing-dispatch.ts";
import { routingRuntime } from "./routing-runtime.ts";
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
    if (
      !params ||
      event.instanceId !==
        processingInstanceId(params.rawKey, params.attempt, params.pipelineVersion)
    ) {
      throw new NonRetryableError("Invalid mail processing identity");
    }
    const session = this.env.MAIL_CATALOG.withSession("first-primary");
    let extracted: { status: string; attachmentCount: number } | undefined;
    try {
      const active = await step.do(`begin-${params.pipelineVersion}`, retry, () =>
        redacted(() => beginProcessing(session, params)),
      );
      if (!active) return { status: "skipped" };
      const result = await step.do(`index-${params.pipelineVersion}`, retry, () =>
        redacted(async () => {
          const current = await readProcessingJob(
            this.env.MAIL_CATALOG.withSession("first-primary"),
            params.rawKey,
            params.pipelineVersion,
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
      if (params.pipelineVersion === "mime-v1") {
        const extraction = await step.do("extract-mime-v1", retry, () =>
          redacted(() =>
            extractArchiveMail(
              this.env.MAIL_ARCHIVE,
              this.env.MAIL_CATALOG,
              params.rawKey,
              event.instanceId,
            ),
          ),
        );
        if (extraction.status !== "complete") {
          // A durable blocked result needs investigation, not retries of the same input.
          throw new NonRetryableError("Mail extraction is blocked");
        }
        await step.do("complete-mime-v1", retry, () =>
          redacted(() => completeProcessing(session, params)),
        );
        extracted = { status: "extracted", ...result, attachmentCount: extraction.attachmentCount };
      } else {
        await step.do("complete-catalog-v1", retry, () =>
          redacted(() => completeProcessing(session, params)),
        );
        return { status: "cataloged", ...result };
      }
    } catch {
      const failureStep =
        params.pipelineVersion === "catalog-v1"
          ? "record-catalog-failure-v1"
          : "record-mime-failure-v1";
      await step.do(failureStep, retry, () => redacted(() => failProcessing(session, params)));
      throw new NonRetryableError("Mail processing failed");
    }
    // Routing cannot turn a successfully archived/extracted message into a MIME failure.
    // The durable routing ledger and Cron recover any failed delivery step independently.
    try {
      await step.do("dispatch-routing-v1", { ...retry, timeout: "3 minutes" }, () =>
        redacted(() => dispatchRoutingSource(this.env, params.rawKey, routingRuntime(this.env))),
      );
    } catch {
      console.error(JSON.stringify({ event: "routing_dispatch", status: "deferred" }));
    }
    return extracted;
  }
}
