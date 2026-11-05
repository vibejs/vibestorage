import { afterEach, describe, expect, it, vi } from "vitest";
import type { S3Client } from "./s3.ts";
import {
  STORAGE_DRIVER_FAILED,
  STORAGE_INVALID_CONFIG,
  STORAGE_INVALID_KEY,
  STORAGE_TYPE_REJECTED,
  Storage,
  s3Driver,
  s3FetchClient,
} from "./index.ts";
import { EMPTY_PAYLOAD_SHA256, awsUriEncode } from "./sign.ts";

const credentials = {
  bucket: "assets",
  endpoint: "https://accountid.r2.cloudflarestorage.com",
  region: "auto",
  accessKeyId: "AKID",
  secretAccessKey: "secretsecretsecret",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(
  body: Uint8Array,
  status: number,
  headers: Record<string, string> = {},
): Response {
  const bytes = Uint8Array.from(body);
  return {
    status,
    headers: new Headers(headers),
    arrayBuffer: () =>
      Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  } as Response;
}

describe("s3Driver", () => {
  it("rejects bad endpoints, buckets, and clients", () => {
    for (const endpoint of [
      "not a url",
      "ftp://accountid.r2.cloudflarestorage.com",
      "https://accountid.r2.cloudflarestorage.com/bucket",
      "https://accountid.r2.cloudflarestorage.com?x=1",
      "https://accountid.r2.cloudflarestorage.com#h",
      "https://user@accountid.r2.cloudflarestorage.com",
      "https://:pw@accountid.r2.cloudflarestorage.com",
    ]) {
      expect(() => s3Driver({ ...credentials, endpoint })).toThrow(
        expect.objectContaining({ code: STORAGE_INVALID_CONFIG }),
      );
    }
    expect(() => s3Driver({ ...credentials, bucket: "   " })).toThrow(/bucket/);
    expect(() => s3Driver({ ...credentials, bucket: "a/b" })).toThrow(/bucket/);
    expect(() => s3Driver({ ...credentials, bucket: "a b" })).toThrow(/bucket/);
    expect(() => s3Driver({ ...credentials, bucket: "a".repeat(64) })).toThrow(/bucket/);
    expect(() => s3Driver({ ...credentials, bucket: 1 as unknown as string })).toThrow(/bucket/);
    expect(() => s3Driver({ ...credentials, region: "  " })).toThrow(/region/);
    expect(() => s3Driver({ ...credentials, accessKeyId: "  " })).toThrow(/accessKeyId/);
    expect(() => s3Driver({ ...credentials, secretAccessKey: "" })).toThrow(/secretAccessKey/);
    const client = { putObject: async () => {}, getObject: async () => undefined };
    expect(() => s3Driver({ ...credentials, client: client as unknown as S3Client })).toThrow(
      /client/,
    );
    expect(() =>
      s3Driver({
        ...credentials,
        client: {
          ...client,
          getObject: undefined,
          deleteObject: async () => {},
        } as unknown as S3Client,
      }),
    ).toThrow(/client/);
    expect(() =>
      s3Driver({
        ...credentials,
        client: {
          putObject: undefined,
          getObject: async () => undefined,
          deleteObject: async () => {},
        } as unknown as S3Client,
      }),
    ).toThrow(/client/);
  });

  it("presigns R2 path-style and AWS virtual-hosted URLs", async () => {
    const now = new Date("2013-05-24T00:00:00.000Z");
    const client: S3Client = {
      async putObject() {},
      async getObject() {
        return undefined;
      },
      async deleteObject() {},
    };
    const r2 = s3Driver({ ...credentials, client, bucket: " assets " });
    const url = await r2.signedReadUrl("photos/a b!*.png", 86400, now);
    expect(
      url.startsWith("https://accountid.r2.cloudflarestorage.com/assets/photos/a%20b%21%2A.png?"),
    ).toBe(true);
    expect(url).toContain("X-Amz-Algorithm=AWS4-HMAC-SHA256");
    expect(url).toContain("X-Amz-SignedHeaders=host");
    expect(url).toContain("%2Fauto%2F");
    expect(url).toContain("X-Amz-Expires=86400");
    expect(url).toContain("X-Amz-Signature=");
    const other = await s3Driver({
      ...credentials,
      client,
      secretAccessKey: "otherotherother",
    }).signedReadUrl("photos/a b!*.png", 86400, now);
    expect(other).not.toBe(url);

    const aws = await s3Driver({
      ...credentials,
      client,
      endpoint: "https://s3.us-east-1.amazonaws.com",
      region: undefined,
    }).signedReadUrl("a.png", 60, now);
    expect(aws.startsWith("https://assets.s3.us-east-1.amazonaws.com/a.png?")).toBe(true);
    expect(aws).toContain("%2Fus-east-1%2F");

    const forced = await s3Driver({
      ...credentials,
      client,
      endpoint: "https://s3.us-east-1.amazonaws.com",
      forcePathStyle: true,
    }).signedReadUrl("a.png", 60, now);
    expect(forced.startsWith("https://s3.us-east-1.amazonaws.com/assets/a.png?")).toBe(true);

    const root = await s3Driver({
      ...credentials,
      client,
      endpoint: "https://amazonaws.com",
      region: " auto ",
    }).signedReadUrl("a.png", 60, now);
    expect(root.startsWith("https://assets.amazonaws.com/a.png?")).toBe(true);
    expect(root).toContain("%2Fauto%2F");

    await expect(r2.signedReadUrl("../x", 5, now)).rejects.toMatchObject({
      code: STORAGE_INVALID_KEY,
    });
    await expect(r2.signedReadUrl("a.png", 0, now)).rejects.toMatchObject({
      code: STORAGE_INVALID_CONFIG,
    });
    await expect(
      r2.put({ key: "../x", bytes: new Uint8Array(), type: "image/png" }),
    ).rejects.toMatchObject({
      code: STORAGE_INVALID_KEY,
    });
    await expect(r2.get("../x")).rejects.toMatchObject({ code: STORAGE_INVALID_KEY });
    await expect(r2.delete("../x")).rejects.toMatchObject({ code: STORAGE_INVALID_KEY });
  });

  it("uses an injected client and still applies storage limits first", async () => {
    const objects = new Map<string, { body: Uint8Array; type: string; filename?: string }>();
    const client: S3Client = {
      async putObject(input) {
        objects.set(input.key, { body: input.body, type: input.type, filename: input.filename });
      },
      async getObject(input) {
        const found = objects.get(input.key);
        if (!found) return undefined;
        return { bytes: found.body, type: found.type, filename: found.filename };
      },
      async deleteObject(input) {
        objects.delete(input.key);
      },
    };
    const fetchImpl = vi.fn<() => Promise<Response>>(async () => {
      throw new Error("network");
    });
    const driver = s3Driver({ ...credentials, client, fetch: fetchImpl });
    const storage = new Storage({
      driver,
      maxBytes: 10,
      maxFiles: 2,
      types: ["image/png"],
    });
    await expect(
      storage.put({ key: "a.png", bytes: new Uint8Array([1]), type: "text/plain" }),
    ).rejects.toMatchObject({ code: STORAGE_TYPE_REJECTED });
    expect(objects.size).toBe(0);
    await storage.put({
      key: "a.png",
      bytes: new Uint8Array([1, 2]),
      type: "image/png",
      filename: "  ",
    });
    expect(objects.get("a.png")?.type).toBe("image/png");
    expect(objects.get("a.png")?.filename).toBeUndefined();
    expect((await storage.get("a.png")).bytes).toEqual(new Uint8Array([1, 2]));
    await storage.delete("a.png");
    expect(objects.has("a.png")).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("s3FetchClient", () => {
  it("signs PUT, GET, and DELETE with the injected fetch", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const request = init ?? {};
      calls.push({ url: String(url), init: request });
      const method = request.method;
      if (method === "GET") {
        return jsonResponse(new Uint8Array([9]), 200, {
          "content-type": "image/png; charset=binary",
          "x-amz-meta-filename": "a%20b.png",
        });
      }
      return jsonResponse(new Uint8Array(), method === "DELETE" ? 204 : 200);
    });
    const now = () => new Date("2013-05-24T00:00:00.000Z");
    const client = s3FetchClient({
      ...credentials,
      endpoint: "https://s3.us-east-1.amazonaws.com",
      region: "us-east-1",
      fetch: fetchImpl,
      now,
      forcePathStyle: false,
    });
    await client.putObject({
      bucket: "assets",
      key: "a.png",
      body: new Uint8Array([1, 2]),
      type: "image/png",
      filename: "ça.png",
    });
    const put = calls[0];
    expect(put?.url).toBe("https://assets.s3.us-east-1.amazonaws.com/a.png");
    const headers = new Headers(put?.init.headers);
    expect(headers.get("authorization")).toContain(
      "Credential=AKID/20130524/us-east-1/s3/aws4_request",
    );
    expect(headers.get("x-amz-date")).toBe("20130524T000000Z");
    expect(headers.get("x-amz-content-sha256")).not.toBe(EMPTY_PAYLOAD_SHA256);
    expect(headers.get("content-type")).toBe("image/png");
    expect(headers.get("x-amz-meta-filename")).toBe(awsUriEncode("ça.png"));
    expect(headers.get("host")).toBeNull();

    expect(await client.getObject({ bucket: "assets", key: "a.png" })).toEqual({
      bytes: new Uint8Array([9]),
      type: "image/png; charset=binary",
      filename: "a b.png",
    });

    await client.putObject({
      bucket: "assets",
      key: "empty",
      body: new Uint8Array(),
      type: "image/png",
      filename: "   ",
    });
    const emptyHeaders = new Headers(calls[2]?.init.headers);
    expect(emptyHeaders.get("x-amz-content-sha256")).toBe(EMPTY_PAYLOAD_SHA256);
    expect(emptyHeaders.get("x-amz-meta-filename")).toBeNull();

    await client.deleteObject({ bucket: "assets", key: "a.png" });
    expect(calls[3]?.init.method).toBe("DELETE");
    expect(calls[3]?.init.body).toBeUndefined();
  });

  it("maps status codes and falls back to global fetch", async () => {
    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchImpl);
    const driver = s3Driver({
      ...credentials,
      accessKeyId: "  AKID  ",
      secretAccessKey: "  secretsecretsecret  ",
    });
    fetchImpl.mockResolvedValueOnce(jsonResponse(new Uint8Array([4]), 200, {}));
    expect(await driver.get("a.png")).toEqual({
      bytes: new Uint8Array([4]),
      type: "application/octet-stream",
    });
    fetchImpl.mockResolvedValueOnce(jsonResponse(new Uint8Array(), 404));
    expect(await driver.get("missing")).toBeUndefined();
    fetchImpl.mockResolvedValueOnce(
      jsonResponse(new Uint8Array(), 200, { "x-amz-meta-filename": "   " }),
    );
    expect((await driver.get("blank-name"))?.filename).toBeUndefined();
    fetchImpl.mockResolvedValueOnce(
      jsonResponse(new Uint8Array(), 200, { "x-amz-meta-filename": "%" }),
    );
    expect(await driver.get("bad-name")).toMatchObject({ filename: "%" });
    for (const status of [199, 300, 500]) {
      fetchImpl.mockResolvedValueOnce(jsonResponse(new Uint8Array(), status));
      await expect(driver.get("a.png")).rejects.toMatchObject({
        code: STORAGE_DRIVER_FAILED,
        message: `S3 GET failed (${status}).`,
      });
    }
    fetchImpl.mockResolvedValueOnce(jsonResponse(new Uint8Array(), 200));
    await driver.put({ key: "a.png", bytes: new Uint8Array([1]), type: "image/png" });
    fetchImpl.mockResolvedValueOnce(jsonResponse(new Uint8Array(), 500));
    await expect(
      driver.put({ key: "a.png", bytes: new Uint8Array([1]), type: "image/png" }),
    ).rejects.toMatchObject({ message: "S3 PUT failed (500)." });
    fetchImpl.mockResolvedValueOnce(jsonResponse(new Uint8Array(), 404));
    await driver.delete("missing");
    fetchImpl.mockResolvedValueOnce(jsonResponse(new Uint8Array(), 204));
    await driver.delete("a.png");
    fetchImpl.mockResolvedValueOnce(jsonResponse(new Uint8Array(), 500));
    await expect(driver.delete("a.png")).rejects.toMatchObject({
      message: "S3 DELETE failed (500).",
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
      "https://accountid.r2.cloudflarestorage.com/assets/a.png",
    );
    const auth = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("authorization") ?? "";
    expect(auth).toContain("Credential=AKID/");
    expect(auth).not.toContain("  AKID");
  });
});
