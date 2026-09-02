import esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

await rm("web-dist", { recursive: true, force: true });
await mkdir("web-dist", { recursive: true });
await esbuild.build({ entryPoints: ["web-src/app.ts"], outfile: "web-dist/app.js", bundle: true, format: "esm", target: "es2022", minify: process.argv.includes("--production"), sourcemap: process.argv.includes("--production") ? false : "inline", treeShaking: true, logLevel: "info" });
await Promise.all([cp("web/index.html", "web-dist/index.html"), cp("web/app.css", "web-dist/app.css"), cp("web/fonts", "web-dist/fonts", { recursive: true })]);
