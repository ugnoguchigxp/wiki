import devServer from "@hono/vite-dev-server";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    devServer({
      entry: "../api/src/dev-app.ts",
      exclude: [/^\/(?!(api|health)\/).*/, /^\/$/],
    }),
  ],
  server: {
    host: "127.0.0.1",
    port: 8787,
    strictPort: true,
  },
  build: {
    outDir: "../api/public",
    emptyOutDir: true,
  },
});
