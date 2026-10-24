import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    // The 3D room is the one lazy room whose own stack cannot fit Vite's
    // 500 kB default: it is budgeted at 1 MB gzip (it ships about 280 kB gzip)
    // and is deliberately kept as one fetch. Every other chunk is expected to
    // stay well below 500 kB.
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      output: {
        // The rendering and language machinery is what every room stands on,
        // so it is the one thing that never belongs to the first page alone:
        // it ships as chunks of its own rather than padding the entry bundle.
        manualChunks(id) {
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) {
            return "react";
          }
          if (/node_modules\/(i18next|react-i18next)\//.test(id)) {
            return "i18n";
          }
          // Zustand is read by the launcher's own stores as well as by the 3D
          // renderer. Folded into the 3D chunk, an entry that imports the store
          // would import — and preload — the whole 3D stack on the first page.
          if (/node_modules\/zustand\//.test(id)) {
            return "state";
          }
          // Vite's preload helper is used by the entry and by the 3D room
          // alike. Left to Rollup it lands in the 3D chunk, which would again
          // make the entry import that chunk and preload it on the launcher.
          if (/vite\/preload-helper/.test(id)) {
            return "preload";
          }
          // The catalogues are the largest static dependency of the entry:
          // every screen reads words, but they change on their own schedule,
          // so they get a chunk of their own to stay cacheable.
          if (/src\/shared\/i18n\/locales\//.test(id)) {
            return "locales";
          }
          // The document codec is read when a project is opened; its BSON
          // implementation is vendor weight that should not pad the entry.
          if (/node_modules\/bson\//.test(id)) {
            return "bson";
          }
          // The 3D stack is one lazy room's own weight. Keeping it in one
          // chunk makes the room one fetch and keeps it off every other page.
          if (
            /node_modules\/(three|three-stdlib|@react-three|@use-gesture|maath|troika|meshline|three-mesh-bvh|camera-controls|detect-gpu|glsl-noise|suspend-react)\//.test(
              id,
            )
          ) {
            return "three";
          }
        },
      },
    },
  },
  server: {
    strictPort: true,
    port: 1420,
    proxy: {
      "/api": {
        // The same PORT the server started by `make web-serve` listens on.
        target: `http://127.0.0.1:${process.env.PORT ?? 8080}`,
        changeOrigin: false,
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["src/shared/i18n/test-setup.ts"],
  },
});
