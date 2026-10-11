// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { fileURLToPath } from "node:url";

let isBuild = false;

export default defineConfig({
  vite: {
    plugins: [
      // The browser build must never stub Node's built-in `buffer`: rolldown's
      // native resolver externalizes `node:buffer` before aliases apply, which
      // used to emit an empty module and crash safe-buffer/bs58/Solana SDKs.
      // A pre resolveId hook pins every buffer import to the real package.
      {
        name: "buffer-shim",
        enforce: "pre",
        configResolved(c) { isBuild = c.command === "build"; },
        resolveId(specifier): string | undefined {
          // Build only: in dev the raw CommonJS file has no ESM `Buffer` export; there the
          // dependency optimizer pre-bundles `buffer` (optimizeDeps.include below).
          if ((specifier === "buffer" || specifier === "node:buffer") && isBuild) {
            return fileURLToPath(new URL("./node_modules/buffer/index.js", import.meta.url));
          }
          // bigint-buffer's "browser" field maps dist/node.js → dist/browser.js,
          // but rolldown's native resolver misses it, so the Node entry (which
          // loads native bindings via __filename) reaches the browser bundle and
          // crashes on signing. Pin it to the pure-JS browser build.
          // base64-js is CommonJS-only (no exports map); buffer requires it and
          // the native resolver fails to load it in the browser bundle, which
          // surfaced as "No such module base64-js" when connecting a wallet.
          if (specifier === "base64-js" && isBuild) {
            return fileURLToPath(new URL("./node_modules/base64-js/index.js", import.meta.url));
          }
          if (specifier === "bigint-buffer") {
            return fileURLToPath(new URL("./node_modules/bigint-buffer/dist/browser.js", import.meta.url));
          }
          return undefined;
        },
      },
    ],
    optimizeDeps: { include: ["buffer", "base64-js"] },
    resolve: { alias: [
      { find: /^@coral-xyz\/anchor$/, replacement: fileURLToPath(new URL("./node_modules/@coral-xyz/anchor/dist/browser/index.js", import.meta.url)) },
    ] },
    environments: {
      // Solana's packages expose browser and Node entries. Workers use the browser
      // implementations for HTTP/WebSocket reads; no Node socket server is needed.
      nitro: { resolve: { conditions: ["workerd", "worker", "browser", "module", "production"] } },
    },
  },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
