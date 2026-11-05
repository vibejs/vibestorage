import { STORAGE_INVALID_KEY, StorageError } from "./errors.ts";

const MAX_KEY_LENGTH = 1024;

function isControl(code: number): boolean {
  return code <= 0x1f || code === 0x7f;
}

/** Removes ASCII control characters, including DEL. */
export function stripControls(value: string): string {
  let cleaned = "";
  for (const char of value) {
    if (!isControl(char.charCodeAt(0))) cleaned += char;
  }
  return cleaned;
}

/**
 * Accepts a relative object key. Empty keys, absolute keys, control characters, and `.` or `..`
 * segments are rejected before a driver sees them.
 */
export function assertKey(key: string): void {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) {
    throw new StorageError(
      STORAGE_INVALID_KEY,
      "The object key must be a non-empty string of at most 1024 characters.",
    );
  }
  if (key.startsWith("/") || key.includes("\\") || stripControls(key) !== key) {
    throw new StorageError(
      STORAGE_INVALID_KEY,
      "The object key cannot be absolute or contain control characters.",
    );
  }
  if (key.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new StorageError(
      STORAGE_INVALID_KEY,
      "The object key cannot contain an empty, current, or parent segment.",
    );
  }
}
