import { defineConfig } from "vite";

export default defineConfig({
  base: "/",
  build: {
    target: "es2022",
    sourcemap: false,
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
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
