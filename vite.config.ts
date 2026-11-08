import { defineConfig } from "vite";

export default defineConfig({
  // Spark ships a WASM module and web workers; keep it out of dependency pre-bundling.
  optimizeDeps: { exclude: ["@sparkjsdev/spark"] },
  build: { target: "es2022", chunkSizeWarningLimit: 4000 },
});
