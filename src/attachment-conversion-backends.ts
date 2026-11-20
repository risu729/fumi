import {
  conversionText,
  ConversionBlocked,
  digest,
  saveConversionObject,
  redactCandidates,
} from "./attachment-conversion-io.ts";
import { unlockZip } from "./attachment-conversion-zip.ts";

/** Actual Workers AI / AI Search instance binding methods, deliberately no configuration mutations. */
export interface ManagedDocuments {
  toMarkdown(
    file: { name: string; blob: Blob },
    options: ConversionRequestOptions,
  ): Promise<unknown>;
}
export interface ManagedOcr {
  info(): Promise<unknown>;
  items: {
    upload(name: string, content: Blob): Promise<unknown>;
    get(id: string): {
      info(): Promise<unknown>;
      chunks(options: { limit: number; offset: number }): Promise<unknown>;
    };
  };
}
export interface ConversionBindings {
  AI?: ManagedDocuments;
  ATTACHMENT_OCR?: ManagedOcr;
}
export const documentFormats: Readonly<Record<string, string>> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.ms-excel": "xls",
  "application/vnd.ms-excel.sheet.macroenabled.12": "xlsm",
  "application/vnd.ms-excel.sheet.binary.macroenabled.12": "xlsb",
  "text/csv": "csv",
  "text/html": "html",
};
export const ocrFormats: Readonly<Record<string, string>> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};
export const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ConversionBlocked("invalid_provider_response");
  return value as Record<string, unknown>;
};
export function itemKey(sha: string, mime: string) {
  return `fumi-${sha}.${ocrFormats[mime]}`;
}
export function remoteId(value: unknown, expectedKey: string) {
  const response = record(value);
  if (
    typeof response["id"] !== "string" ||
    !/^[\w-]{1,128}$/.test(response["id"]) ||
    response["key"] !== expectedKey
  )
    throw new ConversionBlocked("invalid_provider_response");
  return response["id"];
}
export async function verifyOcr(binding: ManagedOcr) {
  const info = record(await binding.info());
  if (record(info["indexing_options"])["use_ocr"] !== true)
    throw new ConversionBlocked("ocr_not_enabled");
}
const unescapeNames = (text: string) =>
  text.replace(/#([a-f0-9]{2})/gi, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
const mentionsEncrypt = (text: string) => /\/Encrypt\b/.test(unescapeNames(text));
const regular = (char: string | undefined) =>
  char !== undefined && !"\0\t\n\f\r ()<>[]{}/%".includes(char);
/** Finds an `/Encrypt` name outside comments, strings and stream data: the classic or
 * incremental trailer and cross-reference stream dictionaries keep that entry unencrypted.
 * Unterminated string or stream data falls back to any mention in the remaining bytes. */
export function isEncryptedPdf(bytes: Uint8Array, mime: string) {
  if (mime !== "application/pdf") return false;
  const text = new TextDecoder("latin1").decode(bytes);
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "%") {
      while (index < text.length && text[index] !== "\n" && text[index] !== "\r") index++;
    } else if (char === "(") {
      const start = index;
      for (let depth = 0; index < text.length; index++) {
        const inner = text[index];
        if (inner === "\\") index++;
        else if (inner === "(") depth++;
        else if (inner === ")" && --depth === 0) break;
      }
      if (index >= text.length) return mentionsEncrypt(text.slice(start));
      index++;
    } else if (char === "<" && text[index + 1] === "<") {
      index += 2;
    } else if (char === "<") {
      const end = text.indexOf(">", index);
      if (end < 0) return mentionsEncrypt(text.slice(index));
      index = end + 1;
    } else if (char === "/") {
      let end = index + 1;
      while (regular(text[end])) end++;
      if (unescapeNames(text.slice(index + 1, end)) === "Encrypt") return true;
      index = end;
    } else if (!regular(char)) {
      index++;
    } else {
      let end = index;
      while (regular(text[end])) end++;
      if (text.slice(index, end) === "stream") {
        const close = text.indexOf("endstream", end);
        if (close < 0) return mentionsEncrypt(text.slice(end));
        end = close + "endstream".length;
      }
      index = end;
    }
  }
  return false;
}
export async function convertDocument(
  binding: ManagedDocuments,
  bytes: Uint8Array,
  mime: string,
  sha: string,
) {
  const name = `fumi-${sha}.${documentFormats[mime]}`;
  const result = record(
    await binding.toMarkdown(
      { name, blob: new Blob([bytes], { type: mime }) },
      {
        conversionOptions: {
          output: { format: "text" },
          pdf: { metadata: false, images: { convert: false } },
          docx: { images: { convert: false } },
          html: { images: { convert: false } },
        },
      },
    ),
  );
  if (result["name"] !== name || !["text", "markdown"].includes(String(result["format"])))
    throw new ConversionBlocked("document_conversion_failed");
  return {
    bytes: conversionText(result["data"]),
    representation: "managed_document_text",
    provenance: {
      service: "workers-ai-toMarkdown",
      format: result["format"],
      embedded_images: false,
    },
  };
}
export async function collectOcr(binding: ManagedOcr, id: string, key: string) {
  const item = binding.items.get(id);
  const info = record(await item.info());
  if (info["id"] !== id || info["key"] !== key)
    throw new ConversionBlocked("provider_item_changed");
  if (["queued", "running"].includes(String(info["status"]))) return null;
  if (info["status"] !== "completed") throw new ConversionBlocked("ocr_failed");
  if (!Number.isSafeInteger(info["chunks_count"]) || (info["chunks_count"] as number) > 32)
    throw new ConversionBlocked("output_limit");
  const response = record(await item.chunks({ limit: 32, offset: 0 }));
  const pagination = record(response["result_info"]);
  if (
    !Array.isArray(response["result"]) ||
    response["result"].length > 32 ||
    pagination["offset"] !== 0 ||
    pagination["count"] !== response["result"].length ||
    pagination["total"] !== response["result"].length ||
    info["chunks_count"] !== response["result"].length
  )
    throw new ConversionBlocked("output_limit");
  const chunks = response["result"].map((value) => {
    const chunk = record(value);
    if (
      typeof chunk["id"] !== "string" ||
      chunk["id"].length > 128 ||
      typeof chunk["text"] !== "string" ||
      chunk["text"].length > 100000 ||
      !Number.isSafeInteger(chunk["start_byte"]) ||
      !Number.isSafeInteger(chunk["end_byte"]) ||
      (chunk["start_byte"] as number) < 0 ||
      (chunk["end_byte"] as number) < (chunk["start_byte"] as number)
    )
      throw new ConversionBlocked("invalid_provider_response");
    return {
      id: chunk["id"],
      text: chunk["text"],
      start_byte: chunk["start_byte"],
      end_byte: chunk["end_byte"],
    };
  });
  if (chunks.reduce((sum, c) => sum + c.text.length + 2, 0) > 100000)
    throw new ConversionBlocked("output_limit");
  return {
    bytes: conversionText(chunks.map((c) => c.text).join("\n\n")),
    representation: "managed_ocr_indexed_text",
    provenance: {
      service: "ai-search-ocr",
      item_id: id,
      item_key: key,
      chunks: chunks.map((c) => ({ id: c.id, start_byte: c.start_byte, end_byte: c.end_byte })),
      page_numbers_available: false,
    },
  };
}
/** ZIP payloads remain local; generated filenames never become filesystem paths. */
export async function convertZip(
  bucket: R2Bucket,
  bytes: Uint8Array,
  passwords: readonly string[],
) {
  const members = await unlockZip(bytes, passwords);
  const provenance = [];
  const text = [];
  for (const member of members) {
    // oxlint-disable-next-line no-await-in-loop -- Verify and persist one bounded member at a time.
    const object = await saveConversionObject(bucket, member.bytes, "zip-member");
    const textual = /\.(txt|md|csv)$/i.test(member.name);
    let status = "unsupported_member";
    if (textual) {
      try {
        text.push(
          conversionText(
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(member.bytes),
            passwords,
          ),
        );
        status = "indexed_text";
      } catch (error) {
        if (error instanceof ConversionBlocked && error.code !== "no_text") throw error;
        status = "unsupported_encoding_or_empty";
      }
    }
    const name = redactCandidates(member.name, passwords);
    provenance.push({
      index: member.index,
      filename: name,
      encrypted: member.encrypted,
      ...object,
      status,
    });
  }
  const decoded = text.map((memberBytes) => new TextDecoder().decode(memberBytes)).join("\n\n");
  return {
    bytes: decoded
      ? conversionText(decoded, passwords)
      : new TextEncoder().encode(JSON.stringify({ members: provenance, searchable_text: false })),
    representation: decoded ? "local_zip_text" : "local_zip_manifest",
    provenance: {
      service: "zip.js-2.24.0",
      members: provenance,
      recursive: false,
      original_sha256: await digest(bytes),
    },
  };
}
