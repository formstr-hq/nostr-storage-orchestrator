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
      // /admin/* is NIP-98 gated: the event's `u` tag is signed with the
      // console's own origin, and the proxy verifies it against the Host
      // header it receives. String-target shorthand implies
      // `changeOrigin: true`, which rewrites Host to localhost:3001 and makes
      // every admin call fail with "Authorization event URL does not match
      // the request", so preserve the original Host here.
      "/admin": {
        target: "http://localhost:3001",
        changeOrigin: false,
        // The context also matches browser navigations to /admin, which must
        // be served by Vite (SPA fallback) rather than forwarded to the
        // backend. Only XHR/fetch API calls send a non-HTML Accept header.
        bypass(req) {
          if (req.method === "GET" && req.headers.accept?.includes("text/html")) {
            return req.url;
          }
        },
      },
    },
  },
});
