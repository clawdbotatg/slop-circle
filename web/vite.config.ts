import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const pkg = (p: string) => fileURLToPath(new URL(`../packages/${p}`, import.meta.url));

// Static, self-contained build — destined for IPFS pinning, so no
// absolute base path and no external requests at runtime. Base OS packages
// are consumed from source via aliases (no build step for internal packages).
export default defineConfig({
  plugins: [react()],
  base: "./",
  resolve: {
    alias: {
      "@commons/app-kit": pkg("app-kit/src/index.ts"),
      "@commons/os": pkg("os/src/index.ts"),
    },
  },
  server: {
    port: 5180,
    proxy: {
      "/signal": { target: "ws://127.0.0.1:8788", ws: true },
      "/v1": "http://127.0.0.1:8788",
      "/turn": "http://127.0.0.1:8788",
    },
  },
});
