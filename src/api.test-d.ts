import { Storage, type UploadedFile } from "./index.ts";

const file = {
  name: "avatar",
  filename: "a.png",
  type: "image/png",
  bytes: new Uint8Array([1]),
} satisfies UploadedFile;

export const uploaded: UploadedFile = file;

declare const storage: Storage;
declare const files: readonly UploadedFile[];

export const stored = storage.upload(files);
export const again = storage.upload([file]);
