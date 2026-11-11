import { hasScope, type MailPrincipal } from "./principal.ts";
import { createConnectorGmailTransport } from "./gmail-connector-transport.ts";
import {
  runGmailImportPage,
  startGmailImport,
  type GmailImportEnvironment,
  type GmailImportScope,
} from "./gmail-import.ts";
import {
  createReadonlyGmailTransport,
  GMAIL_READONLY_SCOPE,
  GmailImportError,
  type GmailTransport,
} from "./gmail-transport.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      GMAIL_IMPORT_CONFIG?: string;
      GMAIL_IMPORT_ACCESS_TOKEN?: string;
    }
  }
}

export interface GmailImportRuntime {
  importId: string;
  scope: GmailImportScope;
  transport: GmailTransport;
}

/** Network POST requests may expose an empty stream instead of a null body. */
async function hasNoInput(request: Request): Promise<boolean> {
  if (new URL(request.url).search) return false;
  if (!request.body) return true;
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Import input deadline")), 1000);
  });
  try {
    for (let chunks = 0; chunks < 8; chunks++) {
      // oxlint-disable-next-line no-await-in-loop -- Reject the first byte; bound empty chunks and elapsed time.
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

/** Server-owned configuration only. Never accept OAuth material or scope from HTTP/mail. */
export function gmailImportRuntime(env: {
  GMAIL_IMPORT_CONFIG?: string;
  GMAIL_IMPORT_ACCESS_TOKEN?: string;
  MAIL_ARCHIVE?: R2Bucket;
}): GmailImportRuntime | null {
  if (!env.GMAIL_IMPORT_CONFIG) return null;
  try {
    const value = JSON.parse(env.GMAIL_IMPORT_CONFIG) as {
      importId: string;
      expectedAccountHash: string;
      scope: GmailImportScope;
      transport?: "oauth" | "connector";
    };
    if (value.transport === "connector") {
      if (!env.MAIL_ARCHIVE) throw new GmailImportError("invalid_import_configuration");
      return {
        ...value,
        transport: createConnectorGmailTransport({ bucket: env.MAIL_ARCHIVE, ...value }),
      };
    }
    if (value.transport !== undefined && value.transport !== "oauth")
      throw new GmailImportError("invalid_import_configuration");
    if (!env.GMAIL_IMPORT_ACCESS_TOKEN) return null;
    return {
      ...value,
      transport: createReadonlyGmailTransport({
        scopes: [GMAIL_READONLY_SCOPE],
        expectedAccountHash: value.expectedAccountHash,
        accessToken: async () => env.GMAIL_IMPORT_ACCESS_TOKEN!,
      }),
    };
  } catch {
    throw new GmailImportError("invalid_import_configuration");
  }
}

/** Mount only after existing origin and JWT authentication, requiring a separate operator grant. */
export async function handleGmailImport(
  request: Request,
  env: GmailImportEnvironment,
  principal: MailPrincipal,
  runtime: GmailImportRuntime | null,
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
  if (!runtime) return respond({ error: { code: "gmail_import_not_configured" } }, 503);
  const action = /^\/api\/admin\/gmail-import\/(start|status|page)$/.exec(
    new URL(request.url).pathname,
  )?.[1];
  if (!action) return respond({ error: { code: "not_found" } }, 404);
  if (request.method !== (action === "status" ? "GET" : "POST"))
    return respond({ error: { code: "method_not_allowed" } }, 405);
  // These actions intentionally have no request body, query scope, IDs, or credentials.
  if (!(await hasNoInput(request))) return respond({ error: { code: "invalid_request" } }, 400);
  try {
    if (action === "start") {
      await startGmailImport(env, runtime.importId, runtime.scope);
      return respond({ status: "ready" });
    }
    if (action === "page")
      return respond(
        await runGmailImportPage(env, runtime.transport, runtime.importId, runtime.scope),
      );
    const state = await env.MAIL_CATALOG.prepare(
      "SELECT complete,imported_count,revision,pending_json,lease_until FROM gmail_imports WHERE import_id=?",
    )
      .bind(runtime.importId)
      .first<{
        complete: number;
        imported_count: number;
        revision: number;
        pending_json: string | null;
        lease_until: number;
      }>();
    if (!state) return respond({ status: "not_started" });
    return respond({
      status: state.complete ? "complete" : "pending",
      imported_count: state.imported_count,
      revision: state.revision,
      pending_count:
        state.pending_json === null ? 0 : (JSON.parse(state.pending_json) as unknown[]).length,
      busy: state.lease_until > Date.now(),
    });
  } catch (error) {
    return respond(
      { error: { code: error instanceof GmailImportError ? error.code : "gmail_import_failed" } },
      409,
    );
  }
}
