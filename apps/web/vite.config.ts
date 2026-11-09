import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `pnpm --filter @steward/worker dev` serves the API here while `vite` serves the pages.
const worker = "http://localhost:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { "/demo": worker, "/oauth": worker, "/slack": worker, "/health": worker } },
  build: { outDir: "dist", emptyOutDir: true },
});
