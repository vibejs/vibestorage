import { readFileSync } from "node:fs";
import { JsonLogger, Module, VibeFactory } from "@usevibejs/server";
import { describe, expect, it } from "vitest";
import type { StorageDriver, StoredPut } from "./driver.ts";
import {
  STORAGE_DRIVER_FAILED,
  STORAGE_INVALID_CONFIG,
  STORAGE_INVALID_KEY,
  STORAGE_NOT_FOUND,
  STORAGE_TOO_LARGE,
  STORAGE_TOO_MANY,
  STORAGE_TYPE_REJECTED,
  Storage,
  StorageError,
  STORAGE,
  StorageModule,
  type UploadedFile,
} from "./index.ts";

const png = (bytes = "hi"): Uint8Array => new TextEncoder().encode(bytes);

function file(extra: Partial<UploadedFile> = {}): UploadedFile {
  return {
    name: "avatar",
    filename: "a.png",
    type: "image/png",
    bytes: png(),
    ...extra,
  };
}

class Memory {
  readonly puts: StoredPut[] = [];
  readonly deleted: string[] = [];
  failPut = false;
  failDelete = false;
  storageError = false;
  objects = new Map<string, StoredPut>();

  readonly driver: StorageDriver = {
    put: async (object) => {
      if (this.storageError) {
        throw new StorageError(STORAGE_DRIVER_FAILED, "S3 PUT failed (500).");
      }
      if (this.failPut) throw new Error("disk full");
      this.puts.push(object);
      this.objects.set(object.key, object);
    },
    get: async (key) => {
      const found = this.objects.get(key);
      if (!found) return undefined;
      return { bytes: found.bytes, type: found.type, filename: found.filename };
    },
    delete: async (key) => {
      if (this.failDelete) throw new Error("delete failed");
      this.deleted.push(key);
      this.objects.delete(key);
    },
    signedReadUrl: async (key, expiresIn, now) =>
      `https://signed.example/${key}?e=${expiresIn}&t=${now.toISOString()}`,
  };
}

function store(
  memory = new Memory(),
  extra: Partial<ConstructorParameters<typeof Storage>[0]> = {},
) {
  return new Storage({
    driver: memory.driver,
    maxBytes: 5,
    maxFiles: 2,
    types: ["image/png", "image/*"],
    ...extra,
  });
}

describe("Storage limits", () => {
  it("rejects bad limits, drivers, and patterns before use", () => {
    const memory = new Memory();
    const base = { driver: memory.driver, maxBytes: 5, maxFiles: 2, types: ["image/png"] };
    expect(() => store(memory, { maxBytes: 0 })).toThrow(
      expect.objectContaining({ code: STORAGE_INVALID_CONFIG }),
    );
    expect(() => store(memory, { maxBytes: 1.5 })).toThrow(/maxBytes/);
    expect(() => store(memory, { maxFiles: -1 })).toThrow(/maxFiles/);
    expect(() => store(memory, { types: [] })).toThrow(/types/);
    expect(() => store(memory, { types: "image/png" as unknown as string[] })).toThrow(/types/);
    expect(() => store(memory, { types: ["image/png", ""] })).toThrow(/types/);
    expect(() => store(memory, { types: ["image/png", 1 as unknown as string] })).toThrow(/types/);
    expect(() => new Storage({ ...base, driver: null as unknown as StorageDriver })).toThrow(
      /driver/,
    );
    expect(() => new Storage({ ...base, driver: 1 as unknown as StorageDriver })).toThrow(/driver/);
    for (const missing of ["put", "get", "delete", "signedReadUrl"] as const) {
      const driver = { ...memory.driver, [missing]: undefined };
      expect(() => new Storage({ ...base, driver: driver as StorageDriver })).toThrow(/driver/);
    }
    expect(new StorageError(STORAGE_INVALID_CONFIG, "bad", { cause: 1 }).cause).toBe(1);
    expect(new StorageError(STORAGE_INVALID_CONFIG, "bad").name).toBe("StorageError");
  });

  it("checks type and size before the driver, and keeps a copy of the patterns", async () => {
    const memory = new Memory();
    const types = [" IMAGE/PNG "];
    const storage = store(memory, { types, maxBytes: 4 });
    types.push("text/plain");
    await expect(
      storage.put({ key: "a.txt", bytes: png("hi"), type: "text/plain" }),
    ).rejects.toMatchObject({
      code: STORAGE_TYPE_REJECTED,
    });
    await expect(
      storage.put({ key: "a.png", bytes: png("hi"), type: "   " }),
    ).rejects.toMatchObject({
      code: STORAGE_TYPE_REJECTED,
    });
    await expect(
      storage.put({ key: "a.png", bytes: png("hi"), type: 1 as unknown as string }),
    ).rejects.toMatchObject({ code: STORAGE_TYPE_REJECTED });
    await expect(
      storage.put({ key: "a.png", bytes: png("hello"), type: "image/png" }),
    ).rejects.toMatchObject({
      code: STORAGE_TOO_LARGE,
    });
    expect(memory.puts).toHaveLength(0);
    const stored = await storage.put({
      key: "photos/a.png",
      bytes: png("hi"),
      type: "Image/PNG; charset=binary",
      filename: "  ",
    });
    expect(stored).toEqual({ key: "photos/a.png", type: "image/png", size: 2 });
    expect(memory.puts[0]).toMatchObject({ type: "image/png", filename: undefined });
    await expect(
      storage.put({ key: "b.png", bytes: "hi" as unknown as Uint8Array, type: "image/png" }),
    ).rejects.toMatchObject({ code: STORAGE_INVALID_CONFIG });
  });

  it("rejects unsafe keys before calling the driver", async () => {
    const memory = new Memory();
    const storage = store(memory);
    const bytes = png("hi");
    const bad = [
      1 as unknown as string,
      "",
      "a".repeat(1025),
      "/a",
      "a\\b",
      "a\n",
      "a\u007f",
      "a//b",
      "a/./b",
      "a/../b",
    ];
    for (const key of bad) {
      await expect(storage.put({ key, bytes, type: "image/png" })).rejects.toMatchObject({
        code: STORAGE_INVALID_KEY,
      });
      await expect(storage.get(key)).rejects.toMatchObject({ code: STORAGE_INVALID_KEY });
      await expect(storage.delete(key)).rejects.toMatchObject({ code: STORAGE_INVALID_KEY });
      await expect(storage.signedReadUrl(key, { expiresIn: 5 })).rejects.toMatchObject({
        code: STORAGE_INVALID_KEY,
      });
    }
    expect(memory.puts).toHaveLength(0);
    const key = `${"a".repeat(1024)}`;
    await storage.put({ key, bytes: png("h"), type: "image/jpeg" });
    expect(memory.puts[0]?.key).toBe(key);
  });
});

describe("Storage objects", () => {
  it("gets, deletes, and signs", async () => {
    const memory = new Memory();
    const now = new Date("2026-01-02T03:04:05.000Z");
    const storage = store(memory, { now: () => now });
    await storage.put({ key: "a.png", bytes: png("hi"), type: "image/png", filename: "a.png" });
    expect(await storage.get("a.png")).toMatchObject({
      key: "a.png",
      type: "image/png",
      size: 2,
      filename: "a.png",
    });
    expect(await storage.signedReadUrl("a.png", { expiresIn: 60 })).toBe(
      "https://signed.example/a.png?e=60&t=2026-01-02T03:04:05.000Z",
    );
    await storage.delete("a.png");
    await expect(storage.get("a.png")).rejects.toMatchObject({ code: STORAGE_NOT_FOUND });
    await storage.delete("missing.png");
    for (const expiresIn of [0, 1.5, 604_801]) {
      await expect(storage.signedReadUrl("a.png", { expiresIn })).rejects.toMatchObject({
        code: STORAGE_INVALID_CONFIG,
      });
    }
    await storage.put({ key: "b.png", bytes: png("yo"), type: "image/gif" });
    expect(await storage.get("b.png")).toEqual({
      key: "b.png",
      bytes: png("yo"),
      type: "image/gif",
      size: 2,
    });
    expect(await storage.signedReadUrl("b.png", { expiresIn: 604_800 })).toContain("e=604800");
  });

  it("uses the current time when no clock is injected", async () => {
    const memory = new Memory();
    const storage = store(memory);
    await storage.put({ key: "a.png", bytes: png("h"), type: "image/png" });
    const before = Date.now();
    const url = await storage.signedReadUrl("a.png", { expiresIn: 30 });
    const after = Date.now();
    const stamp = new Date(new URL(url).searchParams.get("t") ?? "").getTime();
    expect(stamp).toBeGreaterThanOrEqual(before - 1000);
    expect(stamp).toBeLessThanOrEqual(after + 1000);
  });

  it("wraps driver failures and lets storage errors through", async () => {
    const memory = new Memory();
    const storage = store(memory);
    memory.failPut = true;
    await expect(
      storage.put({ key: "a.png", bytes: png("h"), type: "image/png" }),
    ).rejects.toMatchObject({
      code: STORAGE_DRIVER_FAILED,
      cause: expect.any(Error),
    });
    memory.failPut = false;
    memory.storageError = true;
    await expect(
      storage.put({ key: "a.png", bytes: png("h"), type: "image/png" }),
    ).rejects.toMatchObject({
      message: "S3 PUT failed (500).",
    });
    memory.storageError = false;
    memory.driver.get = () => {
      throw new Error("sync");
    };
    await expect(storage.get("a.png")).rejects.toMatchObject({ code: STORAGE_DRIVER_FAILED });
  });
});

describe("upload", () => {
  it("stores files() objects or nothing when a limit fails", async () => {
    const memory = new Memory();
    const storage = store(memory, { maxBytes: 5, maxFiles: 2 });
    expect(await storage.upload([])).toEqual([]);
    await expect(storage.upload([file(), file(), file()])).rejects.toMatchObject({
      code: STORAGE_TOO_MANY,
    });
    await expect(storage.upload([null] as unknown as UploadedFile[])).rejects.toMatchObject({
      code: STORAGE_INVALID_CONFIG,
    });
    await expect(storage.upload("nope" as unknown as UploadedFile[])).rejects.toMatchObject({
      code: STORAGE_INVALID_CONFIG,
    });
    await expect(
      storage.upload([file({ bytes: png("123") }), file({ bytes: png("456") })]),
    ).rejects.toMatchObject({ code: STORAGE_TOO_LARGE });
    await expect(storage.upload([file({ bytes: png("123456") })])).rejects.toMatchObject({
      code: STORAGE_TOO_LARGE,
      message: expect.stringMatching(/object/),
    });
    await expect(storage.upload([file({ type: "text/plain" })])).rejects.toMatchObject({
      code: STORAGE_TYPE_REJECTED,
    });
    await expect(storage.upload([file(), file()], { key: () => "../x" })).rejects.toMatchObject({
      code: STORAGE_INVALID_KEY,
    });
    await expect(storage.upload([file(), file()], { key: () => "same.png" })).rejects.toMatchObject(
      { code: STORAGE_INVALID_KEY },
    );
    expect(memory.puts).toHaveLength(0);

    const stored = await storage.upload(
      [file({ filename: "./../a b.png", name: "field" }), file({ filename: "/", bytes: png("z") })],
      undefined,
    );
    expect(stored[0]?.key).toMatch(/^[0-9a-f-]{36}\/a b\.png$/);
    expect(stored[1]?.key).toMatch(/^[0-9a-f-]{36}\/file$/);
    const controls = await storage.upload([file({ filename: "\n", bytes: png("q") })]);
    expect(controls[0]?.key).toMatch(/^[0-9a-f-]{36}\/file$/);
    expect(stored[0]).toMatchObject({ type: "image/png", size: 2, filename: "./../a b.png" });

    const indexed = await storage.upload(
      [file({ bytes: png("a") }), file({ bytes: png("b"), filename: "a\\b.png" })],
      { key: (_file, index) => `item-${index}.png` },
    );
    expect(indexed.map((item) => item.key)).toEqual(["item-0.png", "item-1.png"]);

    const long = await storage.upload([
      file({ filename: `${"n".repeat(2000)}.png`, bytes: png("q") }),
    ]);
    expect(long[0]?.key.length).toBeLessThanOrEqual(1024);
  });

  it("rolls back stored files when a later put fails", async () => {
    const memory = new Memory();
    const storage = store(memory);
    memory.failPut = true;
    await expect(storage.upload([file()], { key: () => "only.png" })).rejects.toMatchObject({
      code: STORAGE_DRIVER_FAILED,
    });
    expect(memory.deleted).toEqual([]);

    memory.failPut = false;
    let calls = 0;
    memory.driver.put = async (object) => {
      calls += 1;
      if (calls === 2) throw new Error("second");
      memory.puts.push(object);
    };
    await expect(
      storage.upload([file(), file()], { key: (_file, index) => `n-${index}.png` }),
    ).rejects.toMatchObject({ code: STORAGE_DRIVER_FAILED });
    expect(memory.deleted).toEqual(["n-0.png"]);

    memory.failDelete = true;
    calls = 0;
    memory.deleted.length = 0;
    await expect(
      storage.upload([file(), file()], { key: (_file, index) => `m-${index}.png` }),
    ).rejects.toMatchObject({ code: STORAGE_DRIVER_FAILED });
    expect(memory.deleted).toEqual([]);
  });
});

describe("module", () => {
  it("provides Storage and rejects a driver without methods", async () => {
    const memory = new Memory();
    @Module({
      imports: [
        StorageModule.forRoot({
          driver: memory.driver,
          maxBytes: 10,
          maxFiles: 2,
          types: ["image/png"],
        }),
      ],
    })
    class AppModule {}
    const app = await VibeFactory.create(AppModule, {
      logger: new JsonLogger({ level: "silent" }),
    });
    const storage = app.get(STORAGE);
    expect(await storage.put({ key: "a.png", bytes: png("h"), type: "image/png" })).toMatchObject({
      key: "a.png",
      size: 1,
    });
    await app.close();
    expect(() =>
      StorageModule.forRoot({
        driver: { ...memory.driver, put: undefined as unknown as StorageDriver["put"] },
        maxBytes: 10,
        maxFiles: 1,
        types: ["image/png"],
      }),
    ).toThrow(expect.objectContaining({ code: STORAGE_INVALID_CONFIG }));
  });
});

describe("package manifest", () => {
  it("publishes the public entry without a path dependency", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      peerDependencies: Record<string, string>;
      dependencies?: Record<string, string>;
      sideEffects: boolean;
      type: string;
    };
    expect(manifest.peerDependencies["@usevibejs/server"]).toBe("^0.1.0");
    expect(Object.values(manifest.peerDependencies).every((range) => range === "^0.1.0")).toBe(
      true,
    );
    expect(manifest.dependencies).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toMatch(/file:|link:|workspace:/);
    expect(manifest.sideEffects).toBe(false);
    expect(manifest.type).toBe("module");
  });
});
