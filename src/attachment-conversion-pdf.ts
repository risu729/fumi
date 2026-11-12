import code from "../.cloudflare/attachment-parser.js?raw";
import { CONVERSION_LIMITS, ConversionBlocked } from "./attachment-conversion-io.ts";
import { record } from "./attachment-conversion-backends.ts";

export async function unlockPdf(
  loader: WorkerLoader,
  bytes: Uint8Array,
  passwords: readonly string[],
) {
  if (bytes.length > CONVERSION_LIMITS.sourceBytes) throw new ConversionBlocked("pdf_input_limit");
  if (!passwords.length) throw new ConversionBlocked("password_required");
  const deadline = Date.now() + 10000;
  for (const password of passwords) {
    const remaining = Math.min(5000, deadline - Date.now());
    if (remaining <= 0) throw new ConversionBlocked("pdf_resource_limit_or_unavailable");
    const worker = loader.load({
      compatibilityDate: "2026-11-07",
      mainModule: "parser.js",
      modules: { "parser.js": code },
      env: {},
      globalOutbound: null,
      limits: { cpuMs: 2000, subRequests: 0 },
    });
    const parser = worker.getEntrypoint("PdfParser") as unknown as {
      decrypt(bytes: Uint8Array, password: string): Promise<unknown>;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let value: unknown;
    try {
      // oxlint-disable-next-line no-await-in-loop -- A fresh isolated parser per candidate, shared ten-second parent deadline.
      value = await Promise.race([
        parser.decrypt(bytes, password),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("parser_unavailable")), remaining);
        }),
      ]);
    } catch {
      throw new ConversionBlocked("pdf_resource_limit_or_unavailable");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    const response = record(value);
    if (response["status"] === "blocked") {
      if (response["code"] === "password_rejected") continue;
      const known = [
        "pdf_input_limit",
        "pdf_output_limit",
        "pdf_structure_limit",
        "pdf_verification_failed",
        "invalid_pdf",
      ];
      throw new ConversionBlocked(
        known.includes(String(response["code"]))
          ? String(response["code"])
          : "invalid_parser_response",
      );
    }
    if (
      response["status"] !== "complete" ||
      !(response["bytes"] instanceof Uint8Array) ||
      response["bytes"].length > CONVERSION_LIMITS.sourceBytes ||
      !Number.isSafeInteger(response["pages"]) ||
      (response["pages"] as number) > 100 ||
      (response["pages"] as number) < 1 ||
      !Number.isSafeInteger(response["objects"]) ||
      (response["objects"] as number) > 2000
    )
      throw new ConversionBlocked("invalid_parser_response");
    return { bytes: response["bytes"], pages: response["pages"], objects: response["objects"] };
  }
  throw new ConversionBlocked("password_rejected");
}
