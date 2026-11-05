import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ObjectBody, StorageDriver } from "./driver.ts";
import { STORAGE_INVALID_CONFIG, STORAGE_INVALID_SIGNATURE, StorageError } from "./errors.ts";
import { assertKey } from "./key.ts";
import { assertExpires, optionalFilename } from "./limits.ts";

export interface LocalDiskOptions {
  /** Directory that holds object bytes. It is created when the driver is constructed. */
  readonly root: string;
  /** HTTP origin and path prefix for signed read URLs, without a query or hash. */
  readonly baseUrl: string;
  /** HMAC secret. At least 16 characters. */
  readonly secret: string;
}

interface ParsedBase {
  readonly origin: string;
  readonly pathname: string;
}

function endpoint(value: string): ParsedBase {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new StorageError(
      STORAGE_INVALID_CONFIG,
      "The local disk baseUrl must be an http(s) URL.",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new StorageError(
      STORAGE_INVALID_CONFIG,
      "The local disk baseUrl must be an http(s) URL.",
    );
  }
  if (url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
    throw new StorageError(
      STORAGE_INVALID_CONFIG,
      "The local disk baseUrl cannot include a query, hash, or userinfo.",
    );
  }
  const pathname = url.pathname.replace(/\/$/, "") || "/";
  return { origin: url.origin, pathname: pathname === "/" ? "" : pathname };
}

function ensureRoot(root: string): string {
  try {
    mkdirSync(root, { recursive: true });
    return realpathSync(root);
  } catch (error) {
    throw new StorageError(STORAGE_INVALID_CONFIG, "The local disk root is not a directory.", {
      cause: error,
    });
  }
}

function location(root: string, key: string): { dir: string; body: string; meta: string } {
  const hash = createHash("sha256").update(key).digest("hex");
  const dir = join(root, hash.slice(0, 2));
  return { dir, body: join(dir, hash), meta: join(dir, `${hash}.json`) };
}

function isEnoent(error: unknown): boolean {
  return (error as { code?: unknown }).code === "ENOENT";
}

function unreadable(): Error {
  return new Error("The local object metadata is unreadable.");
}

function metaRecord(raw: string, key: string): { type: string; filename?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw unreadable();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw unreadable();
  const type = "type" in parsed ? parsed.type : undefined;
  const storedKey = "key" in parsed ? parsed.key : undefined;
  const filename = "filename" in parsed ? parsed.filename : undefined;
  if (storedKey !== key || typeof type !== "string") throw unreadable();
  if (filename !== undefined && typeof filename !== "string") throw unreadable();
  if (typeof filename === "string") return { type, filename };
  return { type };
}

async function readBody(path: string): Promise<Uint8Array> {
  try {
    return Uint8Array.from(await readFile(path));
  } catch (error) {
    if (isEnoent(error)) {
      throw new Error("The local object is missing its body.", { cause: error });
    }
    throw error;
  }
}

function signature(secret: string, expires: number, key: string): string {
  return createHmac("sha256", secret).update(`v1\n${expires}\n${key}`).digest("base64url");
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function objectUrl(base: ParsedBase, key: string): string {
  const path = key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${base.origin}${base.pathname}/${path}`;
}

function invalidSignature(): StorageError {
  return new StorageError(STORAGE_INVALID_SIGNATURE, "The signed read URL is not valid.");
}

/**
 * Checks a URL from `localDisk().signedReadUrl`. Returns the object key.
 * S3 and R2 check their own signed URLs; this is only for the local driver.
 */
export function verifyLocalRead(
  options: { readonly baseUrl: string; readonly secret: string },
  url: string,
  now = new Date(),
): string {
  const base = endpoint(options.baseUrl);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalidSignature();
  }
  if (parsed.origin !== base.origin) throw invalidSignature();
  const prefix = base.pathname;
  const rest =
    prefix === ""
      ? parsed.pathname.slice(1)
      : parsed.pathname.startsWith(`${prefix}/`)
        ? parsed.pathname.slice(prefix.length + 1)
        : undefined;
  if (rest === undefined || rest === "") throw invalidSignature();
  let key: string;
  try {
    key = rest
      .split("/")
      .map((part) => decodeURIComponent(part))
      .join("/");
  } catch {
    throw invalidSignature();
  }
  assertKey(key);
  const expiresRaw = parsed.searchParams.get("expires");
  const sig = parsed.searchParams.get("sig");
  if (expiresRaw === null || sig === null || !/^\d{1,16}$/.test(expiresRaw))
    throw invalidSignature();
  const expires = Number(expiresRaw);
  if (!Number.isSafeInteger(expires) || expires <= Math.floor(now.getTime() / 1000)) {
    throw invalidSignature();
  }
  if (!same(sig, signature(options.secret, expires, key))) throw invalidSignature();
  return key;
}

/** Stores objects under `root`, addressed by a hash of the key. Signing is HMAC-SHA256. */
export function localDisk(options: LocalDiskOptions): StorageDriver {
  if (typeof options.secret !== "string" || options.secret.length < 16) {
    throw new StorageError(
      STORAGE_INVALID_CONFIG,
      "The local disk secret must be at least 16 characters.",
    );
  }
  const base = endpoint(options.baseUrl);
  const root = ensureRoot(resolve(options.root));
  const secret = options.secret;
  return {
    async put(object) {
      assertKey(object.key);
      const place = location(root, object.key);
      await mkdir(place.dir, { recursive: true });
      const tmp = join(place.dir, `.${randomUUID()}.tmp`);
      await writeFile(tmp, object.bytes);
      await rename(tmp, place.body);
      const filename = optionalFilename(object.filename);
      const record = {
        key: object.key,
        type: object.type,
        ...(filename === undefined ? {} : { filename }),
      };
      await writeFile(place.meta, JSON.stringify(record));
    },
    async get(key) {
      assertKey(key);
      const place = location(root, key);
      let raw: string;
      try {
        raw = await readFile(place.meta, "utf8");
      } catch (error) {
        if (isEnoent(error)) return undefined;
        throw error;
      }
      const meta = metaRecord(raw, key);
      const bytes = await readBody(place.body);
      const body: ObjectBody = { bytes, type: meta.type };
      if (meta.filename !== undefined) return { ...body, filename: meta.filename };
      return body;
    },
    async delete(key) {
      assertKey(key);
      const place = location(root, key);
      await rm(place.body, { force: true });
      await rm(place.meta, { force: true });
    },
    async signedReadUrl(key, expiresIn, now) {
      assertKey(key);
      assertExpires(expiresIn);
      const expires = Math.floor(now.getTime() / 1000) + expiresIn;
      const sig = signature(secret, expires, key);
      return `${objectUrl(base, key)}?expires=${expires}&sig=${sig}`;
    },
  };
}
