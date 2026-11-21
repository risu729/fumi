import { Uint8ArrayReader, ZipReader, type FileEntry } from "@zip.js/zip.js/lib/zip-core-custom.js";
import { CONVERSION_LIMITS as limits, ConversionBlocked } from "./attachment-conversion-io.ts";

export interface UnlockedMember {
  index: number;
  name: string;
  bytes: Uint8Array;
  encrypted: boolean;
}
/** Candidates, or a lookup that runs only after the archive is known to have an encrypted entry. */
export type ZipPasswords = readonly string[] | (() => Promise<readonly string[]>);
interface ListedEntry {
  index: number;
  entry: FileEntry;
}

/** No filesystem paths, worker scripts, WASM, URL fetches or password persistence. */
export async function unlockZip(
  bytes: Uint8Array,
  passwords: ZipPasswords = [],
): Promise<UnlockedMember[]> {
  if (bytes.length > limits.sourceBytes) throw new ConversionBlocked("archive_limit");
  const reader = new ZipReader(new Uint8ArrayReader(bytes), {
    useWebWorkers: false,
    useCompressionStream: true,
    checkSignature: true,
  });
  try {
    const entries = await listEntries(reader);
    let candidates: readonly string[] = [];
    if (entries.some(({ entry }) => entry.encrypted)) {
      // A lookup error keeps its own meaning: a lookup timeout is not a corrupt archive.
      candidates = typeof passwords === "function" ? await passwords() : passwords;
      if (candidates.length > 8 || candidates.some((p) => !p || p.length > 128))
        throw new ConversionBlocked("archive_limit");
      if (!candidates.length) throw new ConversionBlocked("password_required");
    }
    return await extractEntries(entries, candidates);
  } finally {
    await reader.close().catch(() => undefined);
  }
}

/** Checks the declared metadata of every entry; nothing is decrypted or decompressed yet. */
async function listEntries(reader: ZipReader<unknown>): Promise<ListedEntry[]> {
  const entries: ListedEntry[] = [];
  let count = 0;
  let total = 0;
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
      total += entry.uncompressedSize;
      entries.push({ index: count - 1, entry });
    }
  } catch (error) {
    if (error instanceof ConversionBlocked) throw error;
    throw new ConversionBlocked("invalid_archive");
  }
  if (!entries.length) throw new ConversionBlocked("empty_archive");
  return entries;
}

async function extractEntries(entries: readonly ListedEntry[], passwords: readonly string[]) {
  const members: UnlockedMember[] = [];
  let total = 0;
  const signal = AbortSignal.timeout(5000);
  try {
    for (const { index, entry } of entries) {
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
      members.push({ index, name: entry.filename, bytes: result, encrypted: entry.encrypted });
    }
    return members;
  } catch (error) {
    if (error instanceof ConversionBlocked) throw error;
    throw new ConversionBlocked("invalid_archive");
  }
}
