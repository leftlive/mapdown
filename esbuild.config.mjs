import esbuild from "esbuild";
import { builtinModules } from "node:module";
import { jszipOptions, sizeOptions } from "./scripts/bundleOptions.mjs";

const dev = process.argv[2] === "dev";

const options = {
  entryPoints: ["src/main.ts"],
  outfile: "main.js",
  bundle: true,
  format: "cjs",
  target: "es2020",
  platform: "browser",
  external: [
    "obsidian",
    "electron",
    "@codemirror/*",
    "@lezer/*",
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
  ],
  ...jszipOptions,
  ...sizeOptions,
  minify: !dev,
  sourcemap: dev ? "inline" : false,
  logLevel: "info",
};

if (dev) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
