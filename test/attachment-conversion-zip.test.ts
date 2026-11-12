import { describe, expect, it } from "vitest";
import {
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
} from "@zip.js/zip.js/lib/zip-core-custom.js";
import { unlockZip } from "../src/attachment-conversion-zip.ts";
import { redactCandidates } from "../src/attachment-conversion-io.ts";

const text = new TextEncoder().encode("Synthetic encrypted invoice: 12,345 yen.");
async function archive(options: { zipCrypto?: boolean; password?: string; level?: number } = {}) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers: false,
    useCompressionStream: true,
    ...options,
  });
  await writer.add("invoice.txt", new Uint8ArrayReader(text));
  return writer.close();
}
describe("local ZIP runtime compatibility", () => {
  it("redacts marker-shaped and overlapping candidate strings without recreating secrets", () => {
    const passwords = ["redacted", "abc", "abcdef", "█"];
    const result = redactCandidates("redacted abcdef ababc c █", passwords);
    for (const password of passwords) expect(result).not.toContain(password);
  });
  it.each([false, true])(
    "decrypts AES/ZipCrypto in workerd without workers or WASM (%s)",
    async (zipCrypto) => {
      const password = crypto.randomUUID();
      const bytes = await archive({ password, zipCrypto, level: 0 });
      const result = await unlockZip(bytes, ["wrong-synthetic-password", password]);
      expect(result[0]!.bytes).toEqual(text);
      expect(result[0]!.encrypted).toBe(true);
      await expect(unlockZip(bytes)).rejects.toMatchObject({ code: "password_required" });
      await expect(unlockZip(bytes, ["wrong-synthetic-password"])).rejects.toMatchObject({
        code: "password_rejected",
      });
    },
  );
  it("uses native deflate streams inside workerd", async () => {
    const bytes = await archive({ level: 6 });
    expect((await unlockZip(bytes))[0]!.bytes).toEqual(text);
  });
  it("supports non-ASCII AES passwords and rejects corrupted authentication", async () => {
    const password = `合成-🔑-${crypto.randomUUID()}`;
    const bytes = await archive({ password, level: 0 });
    expect((await unlockZip(bytes, [password]))[0]!.bytes).toEqual(text);
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const payload = 30 + header.getUint16(26, true) + header.getUint16(28, true);
    bytes[payload + 20]! ^= 1;
    await expect(unlockZip(bytes, [password])).rejects.toMatchObject({ code: "password_rejected" });
  });
  it("rejects corrupted payload integrity", async () => {
    const bytes = await archive({ level: 0 });
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const payload = 30 + header.getUint16(26, true) + header.getUint16(28, true);
    bytes[payload]! ^= 1;
    await expect(unlockZip(bytes)).rejects.toMatchObject({ code: "invalid_archive" });
  });
  it("rejects expansion bombs and paths before output", async () => {
    const writer = new ZipWriter(new Uint8ArrayWriter(), {
      useWebWorkers: false,
      useCompressionStream: true,
    });
    await writer.add("../outside.txt", new Uint8ArrayReader(text));
    await expect(unlockZip(await writer.close())).rejects.toMatchObject({
      code: "invalid_archive",
    });
    const bomb = new ZipWriter(new Uint8ArrayWriter(), {
      useWebWorkers: false,
      useCompressionStream: true,
    });
    await bomb.add("bomb.txt", new Uint8ArrayReader(new Uint8Array(100000)));
    await expect(unlockZip(await bomb.close())).rejects.toMatchObject({ code: "archive_limit" });
  });
});
