import { resolve } from "node:path";

import { defineConfig } from "vite";

export default defineConfig({
  base: "/",
  build: {
    target: "es2022",
    sourcemap: false,
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      // Two pages. `index.html` is the app; `embed/stats.html` is the
      // standalone rider-stats panel that weseeyouveo.com frames — once an
      // explicit input list exists, the default entry has to be named too or
      // the app stops building.
      input: {
        main: resolve(__dirname, "index.html"),
        embedStats: resolve(__dirname, "embed/stats.html"),
      },
      output: {
        manualChunks: {
          maplibre: ["maplibre-gl"],
        },
      },
    },
  },
  server: {
    port: 5173,
    host: true,
    // The API's CORS allowlist only includes production origins, so in local
    // dev we proxy /api through Vite (server-side requests work from any origin).
    proxy: {
      "/api": {
        target: "https://data.scooter.fyi",
        changeOrigin: true,
        secure: true,
        headers: { Origin: "https://denver.scooter.fyi" },
      },
    },
  },
});
