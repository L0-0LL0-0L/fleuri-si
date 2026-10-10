// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { fileURLToPath } from "node:url";

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
        resolveId(specifier): string | undefined {
          if (specifier === "buffer" || specifier === "node:buffer") {
            return fileURLToPath(new URL("./node_modules/buffer/index.js", import.meta.url));
          }
          return undefined;
        },
      },
    ],
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
