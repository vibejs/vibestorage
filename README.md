# Vibe Storage

**Object storage for vibe.js. Local disk and S3-compatible drivers, including R2.**

The package name is `@usevibejs/storage`.

## Install

```bash
pnpm add @usevibejs/storage @usevibejs/server
```

`@usevibejs/server` is the peer. This package does not depend on an S3 SDK.

## Quick start

`Storage` checks the media type and the byte size, then calls the driver. `upload` accepts the file objects `files()` places on `ctx.files`: `{ name, filename, type, bytes }`. Those limits are applied again here, even when the route already applied them.

```ts
import { localDisk, Storage, verifyLocalRead } from "@usevibejs/storage";

const storage = new Storage({
  driver: localDisk({
    root: "./uploads",
    baseUrl: "https://app.example/files",
    secret: "replace-with-a-long-secret",
  }),
  maxBytes: 1_000_000,
  maxFiles: 4,
  types: ["image/png", "image/*"],
});

await storage.put({ key: "photos/a.png", bytes, type: "image/png", filename: "a.png" });
const object = await storage.get("photos/a.png");
const url = await storage.signedReadUrl("photos/a.png", { expiresIn: 300 });
const key = verifyLocalRead({ baseUrl: "https://app.example/files", secret }, url);
await storage.delete(key);

await storage.upload(ctx.files);
```

`ctx.files` is the array from `files({ maxBytes, maxFiles, types })`. A type ending in `/*` matches that type's subtypes.

## S3 and R2

`region: "auto"` and the default path-style URL are the R2 settings. An `*.amazonaws.com` endpoint uses virtual-hosted URLs unless `forcePathStyle` is set. Signed read URLs are SigV4 query strings. S3 or R2 checks them; this package does not.

```ts
import { s3Driver, StorageModule } from "@usevibejs/storage";

StorageModule.forRoot({
  driver: s3Driver({
    bucket: "assets",
    endpoint: "https://accountid.r2.cloudflarestorage.com",
    region: "auto",
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
  }),
  maxBytes: 5_000_000,
  maxFiles: 4,
  types: ["image/png", "image/*"],
});
```

Inject `STORAGE` and call `upload`, `put`, `get`, `delete`, or `signedReadUrl`. Pass `client` to `s3Driver` to supply your own S3 client. Omit it to use `fetch`.

## Keys

A key is a relative path of at most 1024 characters. `/`, `\`, control characters, and empty, `.`, or `..` segments are rejected. `upload` defaults to `<random>/<filename>` and refuses a repeated key.

## Error codes

See [docs/errors.md](docs/errors.md).

## Local development

```bash
pnpm install
pnpm check
```

`pnpm check` formats, lints, typechecks, and runs tests at 100% per-file coverage. Tests use a temporary directory and a fake S3 client. They do not call a live network.

## Releases

Releases use changesets. A maintainer runs the Release workflow from main. Do not publish by hand.

## License

MIT. See [LICENSE](LICENSE) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
