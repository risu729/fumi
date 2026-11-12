import { Uint8ArrayReader, ZipReader } from "@zip.js/zip.js/lib/zip-core-custom.js";
import { CONVERSION_LIMITS as limits, ConversionBlocked } from "./attachment-conversion-io.ts";

export interface UnlockedMember {
  index: number;
  name: string;
  bytes: Uint8Array;
  encrypted: boolean;
}

/** No filesystem paths, worker scripts, WASM, URL fetches or password persistence. */
export async function unlockZip(
  bytes: Uint8Array,
  passwords: readonly string[] = [],
): Promise<UnlockedMember[]> {
  if (
    bytes.length > limits.sourceBytes ||
    passwords.length > 8 ||
    passwords.some((p) => !p || p.length > 128)
  )
    throw new ConversionBlocked("archive_limit");
  const reader = new ZipReader(new Uint8ArrayReader(bytes), {
    useWebWorkers: false,
    useCompressionStream: true,
    checkSignature: true,
  });
  const members: UnlockedMember[] = [];
  let count = 0;
  let total = 0;
  const signal = AbortSignal.timeout(5000);
  try {
    for await (const entry of reader.getEntriesGenerator()) {
      count++;
      if (
        count > limits.entries ||
        entry.filename.length > 200 ||
        entry.filename.startsWith("/") ||
        entry.filename.includes("\\") ||
        entry.filename.split("/").includes("..")
      )
        throw new ConversionBlocked("archive_limit");
      if (entry.directory) continue;
      if (
        !Number.isSafeInteger(entry.uncompressedSize) ||
        entry.uncompressedSize > limits.sourceBytes ||
        total + entry.uncompressedSize > limits.expandedBytes ||
        entry.uncompressedSize > Math.max(1, entry.compressedSize) * limits.ratio
      )
        throw new ConversionBlocked("archive_limit");
      if (entry.encrypted && !passwords.length) throw new ConversionBlocked("password_required");
      let result: Uint8Array | null = null;
      for (const password of entry.encrypted ? passwords : [undefined]) {
        const chunks: Uint8Array[] = [];
        let size = 0;
        let overflow = false;
        const sink = new WritableStream<Uint8Array>({
          write(chunk) {
            size += chunk.length;
            if (
              size > limits.sourceBytes ||
              total + size > limits.expandedBytes ||
              size > entry.uncompressedSize
            ) {
              overflow = true;
              throw new ConversionBlocked("archive_limit");
            }
            chunks.push(chunk.slice());
          },
        });
        try {
          // oxlint-disable-next-line no-await-in-loop -- At most eight verified password attempts, one bounded entry at a time.
          await entry.getData(sink, {
            ...(password === undefined ? {} : { password }),
            signal,
            checkSignature: true,
            checkOverlappingEntry: true,
            useWebWorkers: false,
            useCompressionStream: true,
          });
          if (size !== entry.uncompressedSize) throw new ConversionBlocked("invalid_archive");
          result = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
          }
          break;
        } catch {
          if (overflow) throw new ConversionBlocked("archive_limit");
          if (signal.aborted) throw new ConversionBlocked("archive_timeout");
        }
      }
      if (!result)
        throw new ConversionBlocked(entry.encrypted ? "password_rejected" : "invalid_archive");
      total += result.length;
      members.push({
        index: count - 1,
        name: entry.filename,
        bytes: result,
        encrypted: entry.encrypted,
      });
    }
    if (!members.length) throw new ConversionBlocked("empty_archive");
    return members;
  } catch (error) {
    if (error instanceof ConversionBlocked) throw error;
    throw new ConversionBlocked("invalid_archive");
  } finally {
    await reader.close().catch(() => undefined);
  }
}
