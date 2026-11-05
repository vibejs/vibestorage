/** Stable codes owned by `@usevibejs/storage`. They are not vibe.js framework codes. */
export const STORAGE_INVALID_CONFIG = "STORAGE_INVALID_CONFIG";
export const STORAGE_INVALID_KEY = "STORAGE_INVALID_KEY";
export const STORAGE_TYPE_REJECTED = "STORAGE_TYPE_REJECTED";
export const STORAGE_TOO_LARGE = "STORAGE_TOO_LARGE";
export const STORAGE_TOO_MANY = "STORAGE_TOO_MANY";
export const STORAGE_NOT_FOUND = "STORAGE_NOT_FOUND";
export const STORAGE_INVALID_SIGNATURE = "STORAGE_INVALID_SIGNATURE";
export const STORAGE_DRIVER_FAILED = "STORAGE_DRIVER_FAILED";

/** A storage error. `code` is stable. */
export class StorageError extends Error {
  override readonly name = "StorageError";
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}
