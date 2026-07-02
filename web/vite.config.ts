import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Static, self-contained build — destined for IPFS pinning, so no
// absolute base path and no external requests at runtime.
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { port: 5180 },
});
