import { createHash, createHmac } from "node:crypto";

/** SHA-256 of an empty payload. Header-signed GET and DELETE use this. */
export const EMPTY_PAYLOAD_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** Presigned URLs sign this instead of a body hash. */
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

/** Encodes one path segment or query component the way SigV4 requires. */
export function awsUriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Encodes an object key, keeping `/` as the segment separator. */
export function encodeKey(key: string): string {
  return key
    .split("/")
    .map((part) => awsUriEncode(part))
    .join("/");
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** `YYYYMMDDTHHmmssZ` and the date stamp SigV4 puts in the credential scope. */
export function amzTimestamp(now: Date): { readonly amz: string; readonly stamp: string } {
  const amz = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return { amz, stamp: amz.slice(0, 8) };
}

function canonicalHeaderValue(value: string): string {
  return value.trim().replace(/[ \t]+/g, " ");
}

function headerEntries(
  headers: Readonly<Record<string, string>>,
): readonly (readonly [string, string])[] {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    normalized[name.toLowerCase()] = canonicalHeaderValue(value);
  }
  return Object.entries(normalized).sort((left, right) => left[0].localeCompare(right[0]));
}

export function canonicalQuery(query: Readonly<Record<string, string>>): string {
  return Object.entries(query)
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([name, value]) => `${awsUriEncode(name)}=${awsUriEncode(value)}`)
    .join("&");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function signingKey(secret: string, stamp: string, region: string): Buffer {
  const date = hmac(`AWS4${secret}`, stamp);
  const regionKey = hmac(date, region);
  const service = hmac(regionKey, "s3");
  return hmac(service, "aws4_request");
}

export interface SignInput {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly payloadHash: string;
  readonly region: string;
  readonly secretAccessKey: string;
  readonly amzDate: string;
}

export function sign(input: SignInput): {
  readonly signature: string;
  readonly signedHeaders: string;
} {
  const entries = headerEntries(input.headers);
  const block = entries.map(([name, value]) => `${name}:${value}\n`).join("");
  const signedHeaders = entries.map(([name]) => name).join(";");
  // Canonical headers already end in a newline. The extra newline is the blank line SigV4 requires
  // before the signed-header list.
  const canonical = `${input.method.toUpperCase()}\n${input.path}\n${canonicalQuery(input.query)}\n${block}\n${signedHeaders}\n${input.payloadHash}`;
  const stamp = input.amzDate.slice(0, 8);
  const scope = `${stamp}/${input.region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${input.amzDate}\n${scope}\n${sha256Hex(canonical)}`;
  const signature = createHmac("sha256", signingKey(input.secretAccessKey, stamp, input.region))
    .update(stringToSign)
    .digest("hex");
  return { signature, signedHeaders };
}
