import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root,
  publicDir: "public",
  server: {
    host: "0.0.0.0",
    port: Number(process.env.SPACE_PORT || process.env.PORT || 3000),
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(root, "index.html"),
      },
    },
  },
  resolve: {
    alias: {
      "@": resolve(root, "src"),
      "@pages": resolve(root, "pages"),
    },
  },
});
