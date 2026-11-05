import { describe, expect, it } from "vitest";
import {
  EMPTY_PAYLOAD_SHA256,
  UNSIGNED_PAYLOAD,
  amzTimestamp,
  awsUriEncode,
  canonicalQuery,
  encodeKey,
  sha256Hex,
  sign,
} from "./sign.ts";

const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

describe("SigV4", () => {
  it("matches the AWS GET Object signature", () => {
    const signed = sign({
      method: "get",
      path: "/test.txt",
      query: {},
      headers: {
        Host: "examplebucket.s3.amazonaws.com",
        Range: "bytes=0-9",
        "X-Amz-Content-Sha256": EMPTY_PAYLOAD_SHA256,
        "X-Amz-Date": "20130524T000000Z",
      },
      payloadHash: EMPTY_PAYLOAD_SHA256,
      region: "us-east-1",
      secretAccessKey: secret,
      amzDate: "20130524T000000Z",
    });
    expect(signed.signedHeaders).toBe("host;range;x-amz-content-sha256;x-amz-date");
    expect(signed.signature).toBe(
      "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("collapses header whitespace and ignores header case", () => {
    const left = sign({
      method: "GET",
      path: "/",
      query: {},
      headers: { host: "example.com", "x-amz-meta-filename": "a.png" },
      payloadHash: UNSIGNED_PAYLOAD,
      region: "us-east-1",
      secretAccessKey: secret,
      amzDate: "20130524T000000Z",
    });
    const right = sign({
      method: "GET",
      path: "/",
      query: {},
      headers: { HOST: " example.com ", "X-Amz-Meta-Filename": "  a.png  " },
      payloadHash: UNSIGNED_PAYLOAD,
      region: "us-east-1",
      secretAccessKey: secret,
      amzDate: "20130524T000000Z",
    });
    expect(left.signature).toBe(right.signature);
    const spaced = sign({
      method: "GET",
      path: "/",
      query: {},
      headers: { host: "example.com", "x-amz-meta-filename": "a  \t  png" },
      payloadHash: UNSIGNED_PAYLOAD,
      region: "us-east-1",
      secretAccessKey: secret,
      amzDate: "20130524T000000Z",
    });
    expect(spaced.signature).not.toBe(left.signature);
  });

  it("encodes query values and key segments", () => {
    expect(canonicalQuery({ b: "2", a: "a/b" })).toBe("a=a%2Fb&b=2");
    expect(canonicalQuery({})).toBe("");
    expect(awsUriEncode("a b!*'()")).toBe("a%20b%21%2A%27%28%29");
    expect(encodeKey("photos/a b.png")).toBe("photos/a%20b.png");
    expect(encodeKey("a.png")).toBe("a.png");
    expect(sha256Hex("")).toBe(EMPTY_PAYLOAD_SHA256);
    expect(sha256Hex(new Uint8Array())).toBe(EMPTY_PAYLOAD_SHA256);
    expect(amzTimestamp(new Date("2013-05-24T00:00:00.000Z"))).toEqual({
      amz: "20130524T000000Z",
      stamp: "20130524",
    });
  });
});
