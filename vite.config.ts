import { defineConfig } from "vite";
export default defineConfig({
  build: { outDir: "dist", assetsDir: "assets", chunkSizeWarningLimit: 3000 },
  server: {
    port: 5199,
    proxy: {
      "/live": { target: "ws://127.0.0.1:8787", ws: true },
      "/api": "http://127.0.0.1:8787",
    },
  },
});
