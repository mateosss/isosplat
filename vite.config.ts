import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths so the build works under any sub-path (e.g. GitHub Pages /isosplat/).
  base: "./",
  // Overridden to true by scripts/build-supplementary.mjs.
  define: { __SUPPLEMENTARY__: "false" },
  // Spark ships a WASM module and web workers; keep it out of dependency pre-bundling.
  optimizeDeps: { exclude: ["@sparkjsdev/spark"] },
  build: { target: "es2022", chunkSizeWarningLimit: 4000 },
});
