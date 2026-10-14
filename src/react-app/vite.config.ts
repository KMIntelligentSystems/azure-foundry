import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    {
      name: "copy-swa-config",
      closeBundle() {
        // Keep the repository-root file canonical while ensuring manual/Vite
        // builds include the Azure edge auth/routing policy in dist.
        fs.copyFileSync(
          path.resolve(here, "../../staticwebapp.config.json"),
          path.resolve(here, "dist/staticwebapp.config.json"),
        );
      },
    },
  ],
  build: {
    outDir: "dist",
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:7071",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:8080",
        ws: true,
      },
    },
  },
});
