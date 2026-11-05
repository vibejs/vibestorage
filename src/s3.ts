import { STORAGE_DRIVER_FAILED, STORAGE_INVALID_CONFIG, StorageError } from "./errors.ts";
import type { ObjectBody, StorageDriver } from "./driver.ts";
import { assertKey } from "./key.ts";
import { assertExpires, optionalFilename } from "./limits.ts";
import {
  UNSIGNED_PAYLOAD,
  amzTimestamp,
  awsUriEncode,
  canonicalQuery,
  encodeKey,
  sha256Hex,
  sign,
} from "./sign.ts";

/** Operations the S3 driver uses. Tests pass a fake. `s3FetchClient` speaks HTTP. */
export interface S3Client {
  putObject(input: {
    readonly bucket: string;
    readonly key: string;
    readonly body: Uint8Array;
    readonly type: string;
    readonly filename?: string;
  }): Promise<void>;
  getObject(input: {
    readonly bucket: string;
    readonly key: string;
  }): Promise<ObjectBody | undefined>;
  deleteObject(input: { readonly bucket: string; readonly key: string }): Promise<void>;
}

export interface S3DriverOptions {
  readonly bucket: string;
  /** Origin only, such as `https://<account>.r2.cloudflarestorage.com`. */
  readonly endpoint: string;
  /** `auto` for Cloudflare R2. Defaults to `us-east-1`. */
  readonly region?: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /**
   * Path-style URLs put the bucket in the path. Defaults to true except for `*.amazonaws.com`,
   * which uses virtual-hosted URLs. R2 stays path-style.
   */
  readonly forcePathStyle?: boolean;
  /** Injected client. When omitted, the driver uses `fetch` and SigV4. */
  readonly client?: S3Client;
  readonly fetch?: typeof fetch;
  /** Clock for header signatures. Signed read URLs use the `now` argument instead. */
  readonly now?: () => Date;
}

interface S3Config {
  readonly bucket: string;
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly pathStyle: boolean;
  readonly fetchImpl: typeof fetch;
  readonly now: () => Date;
}

function required(value: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new StorageError(STORAGE_INVALID_CONFIG, `${label} is required.`);
  }
  return value.trim();
}

function assertEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new StorageError(STORAGE_INVALID_CONFIG, "The S3 endpoint must be an http(s) origin.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new StorageError(STORAGE_INVALID_CONFIG, "The S3 endpoint must be an http(s) origin.");
  }
  if (
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new StorageError(
      STORAGE_INVALID_CONFIG,
      "The S3 endpoint must be an origin without a path, query, hash, or userinfo.",
    );
  }
  return url;
}

function pathStyleFor(endpoint: URL, force: boolean | undefined): boolean {
  if (force !== undefined) return force;
  const host = endpoint.hostname;
  return !host.endsWith(".amazonaws.com") && host !== "amazonaws.com";
}

function resolveS3Config(options: S3DriverOptions): S3Config {
  const bucket = required(options.bucket, "bucket");
  if (bucket.length > 63 || bucket.includes("/") || bucket.includes(" ")) {
    throw new StorageError(STORAGE_INVALID_CONFIG, "bucket must be a single path segment.");
  }
  const endpoint = assertEndpoint(options.endpoint);
  const region = options.region === undefined ? "us-east-1" : required(options.region, "region");
  const accessKeyId = required(options.accessKeyId, "accessKeyId");
  const secretAccessKey = required(options.secretAccessKey, "secretAccessKey");
  return {
    bucket,
    endpoint: endpoint.origin,
    region,
    accessKeyId,
    secretAccessKey,
    pathStyle: pathStyleFor(endpoint, options.forcePathStyle),
    fetchImpl: options.fetch ?? fetch,
    now: options.now ?? (() => new Date()),
  };
}

interface ObjectTarget {
  readonly href: string;
  readonly host: string;
  readonly path: string;
}

function objectTarget(config: S3Config, key: string): ObjectTarget {
  const base = new URL(config.endpoint);
  const host = (config.pathStyle ? base.host : `${config.bucket}.${base.host}`).toLowerCase();
  const path = config.pathStyle
    ? `/${awsUriEncode(config.bucket)}/${encodeKey(key)}`
    : `/${encodeKey(key)}`;
  return { href: `${base.protocol}//${host}${path}`, host, path };
}

function authorization(
  config: S3Config,
  signedHeaders: string,
  signature: string,
  amzDate: string,
): string {
  const scope = `${amzDate.slice(0, 8)}/${config.region}/s3/aws4_request`;
  return `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function presignGet(config: S3Config, key: string, expiresIn: number, now: Date): string {
  const target = objectTarget(config, key);
  const { amz } = amzTimestamp(now);
  const query = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${config.accessKeyId}/${amz.slice(0, 8)}/${config.region}/s3/aws4_request`,
    "X-Amz-Date": amz,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": "host",
  };
  const { signature } = sign({
    method: "GET",
    path: target.path,
    query,
    headers: { host: target.host },
    payloadHash: UNSIGNED_PAYLOAD,
    region: config.region,
    secretAccessKey: config.secretAccessKey,
    amzDate: amz,
  });
  return `${target.href}?${canonicalQuery(query)}&X-Amz-Signature=${signature}`;
}

function success(status: number): boolean {
  return status >= 200 && status < 300;
}

function filenameFrom(header: string | null): string | undefined {
  if (header === null || header.trim() === "") return undefined;
  try {
    return decodeURIComponent(header);
  } catch {
    return header;
  }
}

async function send(
  config: S3Config,
  method: "PUT" | "GET" | "DELETE",
  key: string,
  body: Uint8Array | undefined,
  contentType: string | undefined,
  filename: string | undefined,
): Promise<Response> {
  const payload = body ?? new Uint8Array();
  const payloadHash = sha256Hex(payload);
  const { amz } = amzTimestamp(config.now());
  const target = objectTarget(config, key);
  const headers: Record<string, string> = {
    host: target.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amz,
  };
  if (contentType !== undefined) headers["content-type"] = contentType;
  const safeName = optionalFilename(filename);
  if (safeName !== undefined) headers["x-amz-meta-filename"] = awsUriEncode(safeName);
  const signed = sign({
    method,
    path: target.path,
    query: {},
    headers,
    payloadHash,
    region: config.region,
    secretAccessKey: config.secretAccessKey,
    amzDate: amz,
  });
  const requestHeaders = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (name !== "host") requestHeaders.set(name, value);
  }
  requestHeaders.set(
    "authorization",
    authorization(config, signed.signedHeaders, signed.signature, amz),
  );
  return config.fetchImpl(target.href, {
    method,
    headers: requestHeaders,
    body: method === "PUT" ? payload : undefined,
  });
}

async function failed(response: Response, method: string): Promise<never> {
  await response.arrayBuffer();
  throw new StorageError(STORAGE_DRIVER_FAILED, `S3 ${method} failed (${response.status}).`);
}

/** HTTP client for S3 and R2. Signs each call with SigV4 headers. */
export function s3FetchClient(options: S3DriverOptions): S3Client {
  const config = resolveS3Config(options);
  return {
    async putObject(input) {
      const response = await send(config, "PUT", input.key, input.body, input.type, input.filename);
      if (!success(response.status)) await failed(response, "PUT");
      await response.arrayBuffer();
    },
    async getObject(input) {
      const response = await send(config, "GET", input.key, undefined, undefined, undefined);
      if (response.status === 404) {
        await response.arrayBuffer();
        return undefined;
      }
      if (!success(response.status)) await failed(response, "GET");
      const bytes = new Uint8Array(await response.arrayBuffer());
      const type = response.headers.get("content-type") ?? "application/octet-stream";
      const filename = filenameFrom(response.headers.get("x-amz-meta-filename"));
      const object: ObjectBody = { bytes, type };
      if (filename !== undefined) return { ...object, filename };
      return object;
    },
    async deleteObject(input) {
      const response = await send(config, "DELETE", input.key, undefined, undefined, undefined);
      if (response.status === 404 || success(response.status)) {
        await response.arrayBuffer();
        return;
      }
      await failed(response, "DELETE");
    },
  };
}

/** S3-compatible driver. Pass `region: "auto"` for Cloudflare R2. */
export function s3Driver(options: S3DriverOptions): StorageDriver {
  const config = resolveS3Config(options);
  if (
    options.client !== undefined &&
    (typeof options.client.putObject !== "function" ||
      typeof options.client.getObject !== "function" ||
      typeof options.client.deleteObject !== "function")
  ) {
    throw new StorageError(
      STORAGE_INVALID_CONFIG,
      "An S3 client with putObject, getObject, and deleteObject is required.",
    );
  }
  const client = options.client ?? s3FetchClient(options);
  return {
    async put(object) {
      assertKey(object.key);
      await client.putObject({
        bucket: config.bucket,
        key: object.key,
        body: object.bytes,
        type: object.type,
        filename: optionalFilename(object.filename),
      });
    },
    async get(key) {
      assertKey(key);
      return client.getObject({ bucket: config.bucket, key });
    },
    async delete(key) {
      assertKey(key);
      await client.deleteObject({ bucket: config.bucket, key });
    },
    async signedReadUrl(key, expiresIn, now) {
      assertKey(key);
      assertExpires(expiresIn);
      return presignGet(config, key, expiresIn, now);
    },
  };
}
