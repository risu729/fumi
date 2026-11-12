import { hasScope, type MailPrincipal } from "./principal.ts";
import { repairProcessing } from "./processing-jobs.ts";
import {
  repairAttachmentConversions,
  type AttachmentConversionEnvironment,
} from "./attachment-conversion.ts";
import { resolveAttachmentPasswords } from "./attachment-passwords.ts";
import { repairContentSearch } from "./content-search.ts";
import { repairManagedMailCorpus } from "./managed-mail-corpus.ts";
import type { ManagedMailEnvironment } from "./managed-search-runtime.ts";

export interface ArchiveRepairEnvironment
  extends AttachmentConversionEnvironment, ManagedMailEnvironment {
  MAIL_PROCESSING: Parameters<typeof repairProcessing>[1];
}
type StageName = "processing" | "attachments" | "content_search" | "managed_corpus";
interface StageResult {
  status: "complete" | "disabled" | "failed";
  counts: Partial<Record<"discovered" | "checked" | "deferred" | "processed" | "indexed", number>>;
  error?: { code: string };
}
const failureCodes: Record<StageName, string> = {
  processing: "archive_processing_repair_failed",
  attachments: "archive_attachment_repair_failed",
  content_search: "archive_content_search_repair_failed",
  managed_corpus: "archive_managed_corpus_repair_failed",
};
async function stage(name: StageName, run: () => Promise<StageResult>): Promise<StageResult> {
  try {
    return await run();
  } catch {
    return { status: "failed", counts: {}, error: { code: failureCodes[name] } };
  }
}
/** An HTTP POST can expose a stream containing no bytes instead of a null body. */
async function emptyInput(request: Request): Promise<boolean> {
  if (new URL(request.url).search) return false;
  if (!request.body) return true;
  if (request.bodyUsed || request.body.locked) return false;
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Archive repair input deadline")), 1000);
  });
  try {
    for (let reads = 0; reads < 8; reads++) {
      // oxlint-disable-next-line no-await-in-loop -- Reject the first byte; cap empty reads and total elapsed time.
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) return true;
      if (part.value.byteLength) return false;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await Promise.race([reader.cancel().catch(() => undefined), Promise.resolve()]);
    reader.releaseLock();
  }
}
/** Mount only behind the parent's same-origin and Access/JWT authentication. */
export async function handleArchiveRepair(
  request: Request,
  env: ArchiveRepairEnvironment,
  principal: MailPrincipal,
): Promise<Response> {
  const respond = (data: unknown, status = 200) =>
    Response.json(data, {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  if (!hasScope(principal, "mail:import")) return respond({ error: { code: "forbidden" } }, 403);
  if (new URL(request.url).pathname !== "/api/admin/archive/repair")
    return respond({ error: { code: "not_found" } }, 404);
  if (request.method !== "POST") return respond({ error: { code: "method_not_allowed" } }, 405);
  if (!(await emptyInput(request))) return respond({ error: { code: "invalid_request" } }, 400);

  const processing = await stage("processing", async () => {
    const result = await repairProcessing(env.MAIL_CATALOG, env.MAIL_PROCESSING);
    return {
      status: "complete",
      counts: { discovered: result.discovered, checked: result.checked, deferred: result.deferred },
    };
  });
  const attachments = await stage("attachments", async () => {
    const result = await repairAttachmentConversions({
      ...env,
      resolveAttachmentPasswords: (input) => resolveAttachmentPasswords(env, input),
    });
    return {
      status: result.enabled ? "complete" : "disabled",
      counts: { processed: result.processed },
    };
  });
  const contentSearch = await stage("content_search", async () => {
    const result = await repairContentSearch(env);
    return { status: "complete", counts: { indexed: result.indexed, deferred: result.deferred } };
  });
  const managedCorpus = await stage("managed_corpus", async () => {
    const result = await repairManagedMailCorpus(env);
    return {
      status: result.enabled ? "complete" : "disabled",
      counts: { processed: result.processed },
    };
  });
  const stages = {
    processing,
    attachments,
    content_search: contentSearch,
    managed_corpus: managedCorpus,
  };
  return respond({
    status: Object.values(stages).some((result) => result.status === "failed")
      ? "partial"
      : "complete",
    stages,
  });
}
