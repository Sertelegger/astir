import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Let the browser bundle import the daemon's own source.
 *
 * `src/` is written for Node and spells its relative imports with a `.js`
 * extension, which is correct there and meaningless to a bundler. Rather than
 * fork the pure modules — `frames`, `layout`, `ramp`, `connection` — into a
 * second copy that can drift from the one the daemon and its tests use, the
 * extension is rewritten on resolve. Sharing the module is the entire reason
 * the view and the daemon cannot disagree about what a frame means.
 */
function resolveNodeStyleImports(): Plugin {
  return {
    name: "astir:js-to-ts",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (importer === undefined || !source.startsWith(".") || !source.endsWith(".js")) return null;
      const resolved = await this.resolve(source.replace(/\.js$/, ".ts"), importer, options);
      return resolved ?? null;
    },
  };
}

/**
 * The view is built into `dist/view`, which the daemon serves from `/view`.
 *
 * `base` matters: assets are requested relative to that prefix, and the default
 * of "/" would have the browser ask the daemon for `/assets/…`, which is the
 * data routes' namespace rather than the view's.
 */
export default defineConfig({
  plugins: [resolveNodeStyleImports(), react()],
  root: "view",
  base: "/view/",
  build: {
    outDir: "../dist/view",
    emptyOutDir: true,
    // A tool served over loopback gains nothing from chunk splitting and loses
    // the ability to be reasoned about as "the files the daemon serves".
    chunkSizeWarningLimit: 2000,
  },
});
