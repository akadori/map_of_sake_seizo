import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: "src",
  publicDir: "../public",
  base: "./",
  plugins: [],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    sourcemap: false,
    rolldownOptions: {
      input: {
        main: resolve(__dirname, "src/index.html"),
        about: resolve(__dirname, "src/about.html"),
      },
    },
  },
  server: {
    port: 5173,
    open: true,
  },
});
