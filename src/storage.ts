import { randomUUID } from "node:crypto";
import { assertDriver, type ObjectBody, type StorageDriver, type StoredPut } from "./driver.ts";
import {
  STORAGE_DRIVER_FAILED,
  STORAGE_INVALID_CONFIG,
  STORAGE_INVALID_KEY,
  STORAGE_NOT_FOUND,
  StorageError,
} from "./errors.ts";
import { assertKey, stripControls } from "./key.ts";
import {
  assertExpires,
  assertFileCount,
  assertObjectSize,
  assertPositive,
  assertType,
  assertUploadSize,
  isUploadedFile,
  normalizePatterns,
  optionalFilename,
  type UploadedFile,
} from "./limits.ts";

export interface PutObject {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly type: string;
  readonly filename?: string;
}

/** Metadata returned by `put` and `upload`. `get` adds `bytes`. */
export interface ObjectInfo {
  readonly key: string;
  readonly type: string;
  readonly size: number;
  readonly filename?: string;
}

export interface StoredObject extends ObjectInfo {
  readonly bytes: Uint8Array;
}

export interface SignedReadOptions {
  /** Seconds until the URL expires. A positive integer of at most 604800. */
  readonly expiresIn: number;
}

export interface UploadOptions {
  /** Object key for one file. The default is a random id plus the file's leaf name. */
  readonly key?: (file: UploadedFile, index: number) => string;
}

export interface StorageOptions {
  readonly driver: StorageDriver;
  readonly maxBytes: number;
  readonly maxFiles: number;
  /** Media types. A trailing `/*` matches every subtype. */
  readonly types: readonly string[];
  readonly now?: () => Date;
}

const LEAF_LIMIT = 1024 - 37;

function leafName(filename: string): string {
  const parts = filename
    .split(/[/\\]/)
    .filter((part) => part !== "" && part !== "." && part !== "..");
  const leaf = parts.at(-1) ?? "file";
  const cleaned = stripControls(leaf).trim();
  if (cleaned === "") return "file";
  return cleaned.slice(0, LEAF_LIMIT);
}

function defaultKey(file: UploadedFile): string {
  return `${randomUUID()}/${leafName(file.filename)}`;
}

function describe(object: StoredPut): ObjectInfo {
  const info = { key: object.key, type: object.type, size: object.bytes.byteLength };
  if (object.filename === undefined) return info;
  return { ...info, filename: object.filename };
}

/** `put`, `get`, `delete`, signed reads, and uploads of `files()` objects. */
export class Storage {
  private readonly driver: StorageDriver;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly types: readonly string[];
  private readonly now: () => Date;

  constructor(options: StorageOptions) {
    assertDriver(options.driver);
    assertPositive(options.maxBytes, "maxBytes");
    assertPositive(options.maxFiles, "maxFiles");
    this.driver = options.driver;
    this.maxBytes = options.maxBytes;
    this.maxFiles = options.maxFiles;
    this.types = normalizePatterns(options.types);
    this.now = options.now ?? (() => new Date());
  }

  /** Stores one object. Type and size are checked before the driver runs. */
  async put(input: PutObject): Promise<ObjectInfo> {
    const object = this.accept(input);
    await this.call(() => this.driver.put(object));
    return describe(object);
  }

  /** Reads one object. Missing keys raise `STORAGE_NOT_FOUND`. */
  async get(key: string): Promise<StoredObject> {
    assertKey(key);
    const found = await this.call(() => this.driver.get(key));
    if (found === undefined) {
      throw new StorageError(STORAGE_NOT_FOUND, `No object is stored for ${key}.`);
    }
    return stored(key, found);
  }

  /** Removes one object. A missing key is not an error. */
  async delete(key: string): Promise<void> {
    assertKey(key);
    await this.call(() => this.driver.delete(key));
  }

  /**
   * A URL that can be fetched until it expires. Local URLs are checked with `verifyLocalRead`.
   * S3 and R2 check the signature themselves.
   */
  async signedReadUrl(key: string, options: SignedReadOptions): Promise<string> {
    assertKey(key);
    assertExpires(options.expiresIn);
    return this.call(() => this.driver.signedReadUrl(key, options.expiresIn, this.now()));
  }

  /**
   * Stores every file, or none of them when a later driver call fails.
   * Limits apply again here even when the route already applied `files()`.
   */
  async upload(
    files: readonly UploadedFile[],
    options?: UploadOptions,
  ): Promise<readonly ObjectInfo[]> {
    const prepared = this.prepare(files, options);
    const done: ObjectInfo[] = [];
    try {
      for (const object of prepared) {
        await this.call(() => this.driver.put(object));
        done.push(describe(object));
      }
    } catch (error) {
      for (const object of done) {
        try {
          await this.driver.delete(object.key);
        } catch (rollbackError) {
          void rollbackError;
        }
      }
      throw error;
    }
    return done;
  }

  private accept(input: PutObject): StoredPut {
    assertKey(input.key);
    if (!(input.bytes instanceof Uint8Array)) {
      throw new StorageError(STORAGE_INVALID_CONFIG, "The object bytes must be a Uint8Array.");
    }
    const type = assertType(input.type, this.types);
    assertObjectSize(input.bytes.byteLength, this.maxBytes);
    return {
      key: input.key,
      bytes: input.bytes,
      type,
      filename: optionalFilename(input.filename),
    };
  }

  private prepare(files: readonly UploadedFile[], options: UploadOptions | undefined): StoredPut[] {
    if (!Array.isArray(files)) {
      throw new StorageError(STORAGE_INVALID_CONFIG, "upload expects the file array from files().");
    }
    assertFileCount(files.length, this.maxFiles);
    const keyFor = options?.key ?? defaultKey;
    const prepared: StoredPut[] = [];
    const seen = new Set<string>();
    let total = 0;
    for (const file of files) {
      if (!isUploadedFile(file)) {
        throw new StorageError(
          STORAGE_INVALID_CONFIG,
          "upload expects the file array from files().",
        );
      }
      const object = this.accept({
        key: keyFor(file, prepared.length),
        bytes: file.bytes,
        type: file.type,
        filename: file.filename,
      });
      if (seen.has(object.key)) {
        throw new StorageError(STORAGE_INVALID_KEY, "The upload repeats an object key.");
      }
      seen.add(object.key);
      total += object.bytes.byteLength;
      assertUploadSize(total, this.maxBytes);
      prepared.push(object);
    }
    return prepared;
  }

  private async call<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError(STORAGE_DRIVER_FAILED, "The storage driver failed.", { cause: error });
    }
  }
}

function stored(key: string, body: ObjectBody): StoredObject {
  const object = {
    key,
    bytes: body.bytes,
    type: body.type,
    size: body.bytes.byteLength,
  };
  if (body.filename === undefined) return object;
  return { ...object, filename: body.filename };
}
