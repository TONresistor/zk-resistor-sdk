import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  // @noble/curves v2 is ESM-only; bundle it so the advertised CJS export works.
  noExternal: ["@noble/curves"],
});
