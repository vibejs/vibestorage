import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
  platform: "node",
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
  deps: { neverBundle: ["@usevibejs/server"] },
});
