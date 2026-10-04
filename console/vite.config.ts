import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      "/upload": "http://localhost:3001",
      "/storage": "http://localhost:3001",
      "/account": "http://localhost:3001",
      "/admin": "http://localhost:3001",
    },
  },
});
