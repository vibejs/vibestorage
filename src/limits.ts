import {
  STORAGE_INVALID_CONFIG,
  STORAGE_TOO_LARGE,
  STORAGE_TOO_MANY,
  STORAGE_TYPE_REJECTED,
  StorageError,
} from "./errors.ts";

/** SigV4 query credentials are valid for at most seven days. */
export const MAX_SIGNED_READ_SECONDS = 604_800;

/** One file part produced by `files()`. `ctx.files` is an array of these. */
export interface UploadedFile {
  readonly name: string;
  readonly filename: string;
  readonly type: string;
  readonly bytes: Uint8Array;
}

export function assertPositive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new StorageError(STORAGE_INVALID_CONFIG, `${name} must be a positive integer.`);
  }
}

export function assertExpires(expiresIn: number): void {
  if (!Number.isSafeInteger(expiresIn) || expiresIn < 1 || expiresIn > MAX_SIGNED_READ_SECONDS) {
    throw new StorageError(
      STORAGE_INVALID_CONFIG,
      "expiresIn must be a positive integer of at most 604800 seconds.",
    );
  }
}

/** Copies and normalizes media-type patterns. A trailing `/*` matches every subtype. */
export function normalizePatterns(types: readonly string[]): readonly string[] {
  if (!Array.isArray(types) || types.length === 0) {
    throw new StorageError(
      STORAGE_INVALID_CONFIG,
      "types must be a non-empty list of media types.",
    );
  }
  return types.map((type) => {
    if (typeof type !== "string" || type.trim() === "") {
      throw new StorageError(
        STORAGE_INVALID_CONFIG,
        "types must be a non-empty list of media types.",
      );
    }
    return type.trim().toLowerCase();
  });
}

/** The media type without parameters, lowercased. Empty when `type` is blank. */
export function normalizedType(type: string): string {
  if (typeof type !== "string") return "";
  const [media] = type.split(";", 1);
  return media.trim().toLowerCase();
}

export function typeAllowed(type: string, patterns: readonly string[]): boolean {
  const media = normalizedType(type);
  if (media === "") return false;
  return patterns.some((pattern) => {
    if (pattern.endsWith("/*")) return media.startsWith(pattern.slice(0, -1));
    return media === pattern;
  });
}

export function assertType(type: string, patterns: readonly string[]): string {
  const media = normalizedType(type);
  if (!typeAllowed(media, patterns)) {
    throw new StorageError(
      STORAGE_TYPE_REJECTED,
      media === "" ? "The type is not allowed." : `The type ${media} is not allowed.`,
    );
  }
  return media;
}

export function assertObjectSize(size: number, maxBytes: number): void {
  if (size > maxBytes) {
    throw new StorageError(STORAGE_TOO_LARGE, `The object is larger than ${maxBytes} bytes.`);
  }
}

export function assertUploadSize(size: number, maxBytes: number): void {
  if (size > maxBytes) {
    throw new StorageError(STORAGE_TOO_LARGE, `The upload is larger than ${maxBytes} bytes.`);
  }
}

export function assertFileCount(count: number, maxFiles: number): void {
  if (count > maxFiles) {
    throw new StorageError(STORAGE_TOO_MANY, `The upload has more than ${maxFiles} files.`);
  }
}

export function optionalFilename(filename: string | undefined): string | undefined {
  if (filename === undefined || filename.trim() === "") return undefined;
  return filename;
}

export function isUploadedFile(value: unknown): value is UploadedFile {
  if (typeof value !== "object" || value === null) return false;
  const file = value as UploadedFile;
  return (
    typeof file.name === "string" &&
    typeof file.filename === "string" &&
    typeof file.type === "string" &&
    file.bytes instanceof Uint8Array
  );
}
