// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  vite: {
    // Worker build: these packages only export browser/node conditions; use the browser (fetch-based) build.
    resolve: {
      alias: [
        { find: /^rpc\-websockets$/, replacement: r("node_modules/rpc-websockets/dist/index.browser.mjs") },
        { find: /^@solana\/codecs\-numbers$/, replacement: r("node_modules/@solana/codecs-numbers/dist/index.browser.mjs") },
        { find: /^@solana\/codecs$/, replacement: r("node_modules/@solana/codecs/dist/index.browser.mjs") },
        { find: /^@solana\/errors$/, replacement: r("node_modules/@solana/errors/dist/index.browser.mjs") },
        { find: /^@solana\/codecs\-core$/, replacement: r("node_modules/@solana/codecs-core/dist/index.browser.mjs") },
        { find: /^@solana\/options$/, replacement: r("node_modules/@solana/options/dist/index.browser.mjs") },
        { find: /^@solana\/codecs\-strings$/, replacement: r("node_modules/@solana/codecs-strings/dist/index.browser.mjs") },
        { find: /^@solana\/codecs\-data\-structures$/, replacement: r("node_modules/@solana/codecs-data-structures/dist/index.browser.mjs") },
      ],
    },
  },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
