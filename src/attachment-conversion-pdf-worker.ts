import { WorkerEntrypoint } from "cloudflare:workers";
import { PDF } from "@libpdf/core";

/** Build-time bundled trusted code. Never import this module into the archive isolate. */
export class PdfParser extends WorkerEntrypoint {
  async decrypt(bytes: Uint8Array, password: string) {
    if (bytes.length > 2 * 1024 * 1024 || !password || password.length > 128)
      return { status: "blocked", code: "pdf_input_limit" };
    try {
      const pdf = await PDF.load(bytes, { credentials: password, lenient: false });
      if (!pdf.getSecurity().isEncrypted || !pdf.getSecurity().authenticatedAs)
        return { status: "blocked", code: "password_rejected" };
      const objects = pdf.context.registry.nextObjectNumber;
      const pages = pdf.getPageCount();
      if (
        !Number.isSafeInteger(objects) ||
        objects > 2000 ||
        !Number.isSafeInteger(pages) ||
        pages < 1 ||
        pages > 100
      )
        return { status: "blocked", code: "pdf_structure_limit" };
      pdf.removeProtection();
      const clear = await pdf.save({ compressStreams: false, useXRefStream: false });
      if (clear.length > 2 * 1024 * 1024) return { status: "blocked", code: "pdf_output_limit" };
      const verified = await PDF.load(clear, { lenient: false });
      if (
        verified.getSecurity().isEncrypted ||
        verified.getPageCount() !== pages ||
        verified.context.registry.nextObjectNumber > 2000
      )
        return { status: "blocked", code: "pdf_verification_failed" };
      return { status: "complete", bytes: clear, pages, objects };
    } catch {
      return { status: "blocked", code: "invalid_pdf" };
    }
  }
}
export default {
  fetch() {
    return new Response(null, { status: 404 });
  },
};
