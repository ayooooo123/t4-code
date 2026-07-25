import { builtinModules } from "node:module";
import { defineConfig } from "vite-plus";

const external = new Set([
  "electron",
  "electron-store",
  "electron-updater",
  "hyperdht",
  "sodium-native",
  "ws",
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

export default defineConfig({
  build: {
    outDir: "dist-electron",
    emptyOutDir: true,
    lib: { entry: "src/main.ts", formats: ["cjs"] },
    rollupOptions: {
      external: (id) => external.has(id) || id.startsWith("node:"),
      output: { entryFileNames: "main.cjs", chunkFileNames: "chunks/[name].cjs" },
    },
  },
});
