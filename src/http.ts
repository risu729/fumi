import { apiOrigin, authenticate, HttpError } from "./auth.ts";
import { eventRuntime } from "./event-runtime.ts";
import { handleMailResource, handleMcp } from "./mcp.ts";
import { MailReadError } from "./mail-read.ts";

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
    if (url.pathname !== "/mcp" && !url.pathname.startsWith("/api/mail/"))
      throw new HttpError(404, "not_found");
    const origin = apiOrigin(env);
    if (
      url.origin !== origin ||
      (request.headers.has("origin") && request.headers.get("origin") !== origin)
    )
      throw new HttpError(403, "origin_not_allowed");
    const principal = await authenticate(request, env);
    if (url.pathname === "/mcp") {
      if (!["POST", "GET", "DELETE"].includes(request.method))
        throw new HttpError(405, "method_not_allowed");
      return secured(
        await handleMcp(request, { ...env, eventRuntime: eventRuntime(env) }, principal),
      );
    }
    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
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
