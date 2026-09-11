import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
);

export default defineConfig({
  entry: ["src/index.ts", "src/contract.ts"],
  format: ["esm"],
  target: "es2022",
  dts: false,
  sourcemap: true,
  clean: true,
  define: {
    CURRENT_VERSION: JSON.stringify(pkg.version),
  },
  external: [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-agent-core",
  ],
  noExternal: ["typebox"],
});
