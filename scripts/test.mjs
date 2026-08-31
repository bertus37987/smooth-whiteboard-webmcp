import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const directory = await mkdtemp(join(tmpdir(), "smooth-handwriting-test-"));
try {
  const result = await build({
    entryPoints: ["tests/core.test.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false
  });
  const file = join(directory, "core.test.cjs");
  await writeFile(file, result.outputFiles[0].contents);
  const run = spawnSync(process.execPath, [file], { stdio: "inherit" });
  if (run.status !== 0) process.exit(run.status ?? 1);
} finally {
  await rm(directory, { recursive: true, force: true });
}
