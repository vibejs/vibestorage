import { STORAGE_INVALID_CONFIG, StorageError } from "./errors.ts";

/** Bytes stored for one key, plus the media type recorded at `put`. */
export interface ObjectBody {
  readonly bytes: Uint8Array;
  readonly type: string;
  readonly filename?: string;
}

/** One object handed to a driver after limits have passed. */
export interface StoredPut {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly type: string;
  readonly filename?: string;
}

/**
 * Persistence and signed reads. Implementations do not enforce type or size limits;
 * `Storage` does that before calling them.
 */
export interface StorageDriver {
  put(object: StoredPut): Promise<void>;
  get(key: string): Promise<ObjectBody | undefined>;
  delete(key: string): Promise<void>;
  signedReadUrl(key: string, expiresIn: number, now: Date): Promise<string>;
}

/** Rejects a value that cannot persist objects. */
export function assertDriver(driver: StorageDriver): void {
  if (
    driver === null ||
    typeof driver !== "object" ||
    typeof driver.put !== "function" ||
    typeof driver.get !== "function" ||
    typeof driver.delete !== "function" ||
    typeof driver.signedReadUrl !== "function"
  ) {
    throw new StorageError(
      STORAGE_INVALID_CONFIG,
      "A storage driver with put, get, delete, and signedReadUrl is required.",
    );
  }
}
