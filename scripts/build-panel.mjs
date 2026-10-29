import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
await mkdir("dist/panel", { recursive: true });
await build({
  entryPoints: ["web/panel.js"],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: "dist/panel/panel.js",
  minify: true,
});
await Promise.all(
  ["index.html", "panel.css"].map((file) =>
    copyFile("web/" + file, "dist/panel/" + file),
  ),
);
console.log("Panel built in dist/panel/");
