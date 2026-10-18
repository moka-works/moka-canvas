import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
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
