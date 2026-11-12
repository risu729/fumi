import { apiOrigin, authenticate, HttpError } from "./auth.ts";
import { eventRuntime } from "./event-runtime.ts";
import { handleMailResource, handleMcp } from "./mcp.ts";
import { MailReadError, readAttachmentConversion } from "./mail-read.ts";
import { gmailImportRuntime, handleGmailImport } from "./gmail-import-http.ts";
import { CONNECTOR_STAGE_PATH, handleConnectorStage } from "./gmail-connector-stage.ts";
import { handleRoutingAdmin } from "./routing-admin-http.ts";
import { handleArchiveRepair } from "./archive-repair-http.ts";
import { handleProcessingRetry } from "./processing-retry-http.ts";

function secured(response: Response): Response {
  const result = new Response(response.body, response);
  result.headers.set("Cache-Control", "no-store");
  result.headers.set("X-Content-Type-Options", "nosniff");
  result.headers.set("Referrer-Policy", "no-referrer");
  return result;
}
export async function handleHttp(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const gmailImport = url.pathname.startsWith("/api/admin/gmail-import/");
    const routingAdmin = url.pathname.startsWith("/api/admin/routing/");
    const archiveRepair = url.pathname === "/api/admin/archive/repair";
    const processingRetry = url.pathname.startsWith("/api/admin/archive/retry/");
    if (
      url.pathname !== "/mcp" &&
      !url.pathname.startsWith("/api/mail/") &&
      !gmailImport &&
      !routingAdmin &&
      !archiveRepair &&
      !processingRetry
    )
      throw new HttpError(404, "not_found");
    const origin = apiOrigin(env);
    if (
      url.origin !== origin ||
      (request.headers.has("origin") && request.headers.get("origin") !== origin)
    )
      throw new HttpError(403, "origin_not_allowed");
    const principal = await authenticate(request, env);
    if (processingRetry) return secured(await handleProcessingRetry(request, env, principal));
    if (archiveRepair) return secured(await handleArchiveRepair(request, env, principal));
    if (routingAdmin) return secured(await handleRoutingAdmin(request, env, principal));
    if (gmailImport) {
      if (!principal.scopes.includes("mail:import")) throw new HttpError(403, "forbidden");
      if (url.pathname === CONNECTOR_STAGE_PATH)
        return secured(await handleConnectorStage(request, env, principal));
      return secured(await handleGmailImport(request, env, principal, gmailImportRuntime(env)));
    }
    if (url.pathname === "/mcp") {
      if (!["POST", "GET", "DELETE"].includes(request.method))
        throw new HttpError(405, "method_not_allowed");
      return secured(
        await handleMcp(request, { ...env, eventRuntime: eventRuntime(env) }, principal),
      );
    }
    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
    const conversion =
      /^\/api\/mail\/([^/]+)\/conversions\/(part_\d+)\/([a-f0-9]{64})(?:\/members\/([0-7])\/([a-f0-9]{64}))?$/.exec(
        url.pathname,
      );
    if (conversion)
      return secured(
        await readAttachmentConversion(
          request,
          env,
          principal,
          conversion[1]!,
          conversion[2]!,
          conversion[3]!,
          conversion[4] === undefined
            ? undefined
            : { index: Number(conversion[4]), sha: conversion[5]! },
        ),
      );
    const match = /^\/api\/mail\/([^/]+)\/(raw|body|text|attachments\/([^/]+))$/.exec(url.pathname);
    if (!match) throw new HttpError(404, "not_found");
    return secured(
      await handleMailResource(
        request,
        env,
        principal,
        match[1]!,
        match[3]
          ? "attachment"
          : match[2] === "raw"
            ? "raw"
            : match[2] === "text"
              ? "text"
              : "body",
        match[3],
      ),
    );
  } catch (error) {
    const status =
      error instanceof HttpError ? error.status : error instanceof MailReadError ? 404 : 500;
    const code =
      error instanceof HttpError
        ? error.code
        : error instanceof MailReadError
          ? "mail_unavailable"
          : "internal_error";
    return secured(Response.json({ error: { code } }, { status }));
  }
}
