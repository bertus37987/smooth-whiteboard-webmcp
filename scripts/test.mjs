import { build } from "esbuild";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

const suites = (await readdir("tests")).filter((name) => name.endsWith(".test.ts")).sort();
const directory = await mkdtemp(join(tmpdir(), "smooth-handwriting-test-"));
try {
  for (const suite of suites) {
    const result = await build({
      entryPoints: [join("tests", suite)],
      bundle: true,
      platform: "node",
      format: "cjs",
      write: false
    });
    const file = join(directory, `${basename(suite, ".ts")}.cjs`);
    await writeFile(file, result.outputFiles[0].contents);
    const run = spawnSync(process.execPath, [file], { stdio: "inherit" });
    if (run.status !== 0) process.exit(run.status ?? 1);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
