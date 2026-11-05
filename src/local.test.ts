import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  STORAGE_INVALID_CONFIG,
  STORAGE_INVALID_KEY,
  STORAGE_INVALID_SIGNATURE,
  localDisk,
  verifyLocalRead,
  type LocalDiskOptions,
} from "./index.ts";
import { Storage } from "./storage.ts";

const secret = "test-secret-value";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vibestorage-"));
  roots.push(dir);
  return dir;
}

function options(dir: string, extra: Partial<LocalDiskOptions> = {}): LocalDiskOptions {
  return {
    root: dir,
    baseUrl: "https://app.example/files",
    secret,
    ...extra,
  };
}

async function paths(dir: string): Promise<{ body: string; meta: string }> {
  const found: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(path);
    }
  }
  await walk(dir);
  const meta = found.find((path) => path.endsWith(".json"));
  const body = found.find((path) => !path.endsWith(".json") && !path.includes(".tmp"));
  if (meta === undefined || body === undefined) throw new Error("missing object files");
  return { body, meta };
}

describe("localDisk", () => {
  it("rejects a bad root, secret, or base URL", async () => {
    const dir = await tempDir();
    const file = join(dir, "not-dir");
    await writeFile(file, "x");
    expect(() => localDisk(options(join(file, "child")))).toThrow(
      expect.objectContaining({ code: STORAGE_INVALID_CONFIG }),
    );
    expect(() => localDisk(options(dir, { secret: "short" }))).toThrow(/secret/);
    expect(() => localDisk(options(dir, { secret: 1 as unknown as string }))).toThrow(/secret/);
    for (const baseUrl of [
      "not a url",
      "ftp://app.example/files",
      "https://app.example/files?x=1",
      "https://app.example/files#h",
      "https://user@app.example/files",
      "https://:pw@app.example/files",
    ]) {
      expect(() => localDisk(options(dir, { baseUrl }))).toThrow(
        expect.objectContaining({ code: STORAGE_INVALID_CONFIG }),
      );
    }
  });

  it("round-trips objects and signed URLs", async () => {
    const dir = await tempDir();
    const now = new Date("2026-01-02T03:04:05.000Z");
    const disk = localDisk(options(dir, { baseUrl: "https://app.example/files/" }));
    const bytes = new TextEncoder().encode("hello");
    await disk.put({ key: "photos/ça.png", bytes, type: "image/png", filename: "ça.png" });
    expect(await disk.get("photos/ça.png")).toEqual({
      bytes,
      type: "image/png",
      filename: "ça.png",
    });
    await disk.put({ key: "photos/ça.png", bytes: new Uint8Array([1]), type: "image/png" });
    expect(await disk.get("photos/ça.png")).toEqual({
      bytes: new Uint8Array([1]),
      type: "image/png",
    });
    const url = await disk.signedReadUrl("photos/ça.png", 60, now);
    expect(url.startsWith("https://app.example/files/photos/%C3%A7a.png?")).toBe(true);
    expect(verifyLocalRead(options(dir), url, now)).toBe("photos/ça.png");
    expect(verifyLocalRead(options(dir), `${url}&extra=1#hash`, now)).toBe("photos/ça.png");
    await disk.delete("photos/ça.png");
    expect(await disk.get("photos/ça.png")).toBeUndefined();
    await disk.delete("missing.png");
    const origin = localDisk(options(dir, { baseUrl: "http://app.example" }));
    await origin.put({ key: "a.png", bytes, type: "image/png", filename: "   " });
    const bare = await origin.signedReadUrl("a.png", 60, now);
    expect(bare.startsWith("http://app.example/a.png?")).toBe(true);
    expect(verifyLocalRead({ baseUrl: "http://app.example/", secret }, bare, now)).toBe("a.png");
  });

  it("rejects bad keys and expiry on the driver", async () => {
    const dir = await tempDir();
    const disk = localDisk(options(dir));
    const bytes = new Uint8Array([1]);
    await expect(disk.put({ key: "../x", bytes, type: "image/png" })).rejects.toMatchObject({
      code: STORAGE_INVALID_KEY,
    });
    await expect(disk.get("../x")).rejects.toMatchObject({ code: STORAGE_INVALID_KEY });
    await expect(disk.delete("../x")).rejects.toMatchObject({ code: STORAGE_INVALID_KEY });
    await expect(disk.signedReadUrl("../x", 5, new Date())).rejects.toMatchObject({
      code: STORAGE_INVALID_KEY,
    });
    await expect(disk.signedReadUrl("a.png", 0, new Date())).rejects.toMatchObject({
      code: STORAGE_INVALID_CONFIG,
    });
  });

  it("rejects a signed URL that was changed, expired, or malformed", async () => {
    const dir = await tempDir();
    const now = new Date("2026-01-02T03:04:05.000Z");
    const disk = localDisk(options(dir));
    await disk.put({ key: "a.png", bytes: new Uint8Array([1]), type: "image/png" });
    const url = await disk.signedReadUrl("a.png", 60, now);
    const parsed = new URL(url);
    parsed.searchParams.set("sig", "aa");
    expect(() => verifyLocalRead(options(dir), parsed.toString(), now)).toThrow(
      expect.objectContaining({ code: STORAGE_INVALID_SIGNATURE }),
    );
    const sameLength = new URL(url);
    const sig = sameLength.searchParams.get("sig") ?? "";
    sameLength.searchParams.set("sig", `${sig.slice(0, -1)}${sig.endsWith("a") ? "b" : "a"}`);
    expect(() => verifyLocalRead(options(dir), sameLength.toString(), now)).toThrow(/not valid/);
    const later = new Date(now.getTime() + 60_000);
    expect(() => verifyLocalRead(options(dir), url, later)).toThrow(
      expect.objectContaining({ code: STORAGE_INVALID_SIGNATURE }),
    );
    expect(() => verifyLocalRead(options(dir), "not a url", now)).toThrow(/not valid/);
    expect(() =>
      verifyLocalRead(options(dir), "https://other.example/files/a.png?expires=1&sig=abcd", now),
    ).toThrow(/not valid/);
    expect(() =>
      verifyLocalRead(
        options(dir),
        "https://app.example/files-extra/a.png?expires=9&sig=abcd",
        now,
      ),
    ).toThrow(/not valid/);
    expect(() =>
      verifyLocalRead(options(dir), "https://app.example/files/?expires=9&sig=abcd", now),
    ).toThrow(/not valid/);
    expect(() =>
      verifyLocalRead(options(dir), "https://app.example/files/%?expires=9&sig=abcd", now),
    ).toThrow(/not valid/);
    expect(() => verifyLocalRead(options(dir), "https://app.example/files/a%00b", now)).toThrow(
      expect.objectContaining({ code: STORAGE_INVALID_KEY }),
    );
    const unsigned = new URL(url);
    unsigned.searchParams.delete("sig");
    expect(() => verifyLocalRead(options(dir), unsigned.toString(), now)).toThrow(/not valid/);
    const noExpires = new URL(url);
    noExpires.searchParams.delete("expires");
    expect(() => verifyLocalRead(options(dir), noExpires.toString(), now)).toThrow(/not valid/);
    const letters = new URL(url);
    letters.searchParams.set("expires", "12ab");
    expect(() => verifyLocalRead(options(dir), letters.toString(), now)).toThrow(/not valid/);
    const huge = new URL(url);
    huge.searchParams.set("expires", "9007199254740993");
    expect(() => verifyLocalRead(options(dir), huge.toString(), now)).toThrow(/not valid/);
    expect(() => verifyLocalRead({ baseUrl: "ftp://app.example", secret }, url, now)).toThrow(
      expect.objectContaining({ code: STORAGE_INVALID_CONFIG }),
    );
    const fresh = await disk.signedReadUrl("a.png", 600, new Date());
    expect(verifyLocalRead(options(dir), fresh)).toBe("a.png");
  });

  it("reports unreadable metadata and a missing body", async () => {
    const dir = await tempDir();
    const disk = localDisk(options(dir));
    const bytes = new Uint8Array([1, 2]);
    await disk.put({ key: "a.png", bytes, type: "image/png", filename: "a.png" });
    const place = await paths(dir);
    await writeFile(place.meta, "not-json");
    await expect(disk.get("a.png")).rejects.toThrow(/unreadable/);
    await writeFile(place.meta, "null");
    await expect(disk.get("a.png")).rejects.toThrow(/unreadable/);
    await writeFile(place.meta, '"x"');
    await expect(disk.get("a.png")).rejects.toThrow(/unreadable/);
    await writeFile(place.meta, "[]");
    await expect(disk.get("a.png")).rejects.toThrow(/unreadable/);
    await writeFile(place.meta, JSON.stringify({ type: "image/png" }));
    await expect(disk.get("a.png")).rejects.toThrow(/unreadable/);
    await writeFile(place.meta, JSON.stringify({ key: "other", type: "image/png" }));
    await expect(disk.get("a.png")).rejects.toThrow(/unreadable/);
    await writeFile(place.meta, JSON.stringify({ key: "a.png", type: 1 }));
    await expect(disk.get("a.png")).rejects.toThrow(/unreadable/);
    await writeFile(place.meta, JSON.stringify({ key: "a.png" }));
    await expect(disk.get("a.png")).rejects.toThrow(/unreadable/);
    await writeFile(place.meta, JSON.stringify({ key: "a.png", type: "image/png", filename: 1 }));
    await expect(disk.get("a.png")).rejects.toThrow(/unreadable/);
    await rm(place.body);
    await writeFile(
      place.meta,
      JSON.stringify({ key: "a.png", type: "image/png", filename: "a.png" }),
    );
    await expect(disk.get("a.png")).rejects.toThrow(/missing its body/);
    await mkdir(place.body);
    await expect(disk.get("a.png")).rejects.toThrow(/EISDIR/);
    await rm(place.body, { recursive: true });
    await rm(place.meta);
    await mkdir(place.meta);
    await expect(disk.get("a.png")).rejects.toThrow(/EISDIR/);
  });

  it("stores through Storage and verifies the URL", async () => {
    const dir = await tempDir();
    const now = new Date("2026-04-01T00:00:00.000Z");
    const storage = new Storage({
      driver: localDisk(options(dir)),
      maxBytes: 100,
      maxFiles: 2,
      types: ["image/png"],
      now: () => now,
    });
    await storage.put({ key: "a.png", bytes: new Uint8Array([7]), type: "image/png" });
    const url = await storage.signedReadUrl("a.png", { expiresIn: 30 });
    expect(verifyLocalRead(options(dir), url, now)).toBe("a.png");
    expect((await storage.get("a.png")).bytes).toEqual(new Uint8Array([7]));
  });
});
