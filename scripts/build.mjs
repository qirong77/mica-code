import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

console.log("Running prebuild checks...\n");
execSync("bun run prebuild", { stdio: "inherit" });

const outDir = "dist";
const outName = "mica";

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const outFile = join(outDir, outName);
execSync(`bun build --compile ./src/index.ts --outfile ${outFile}`, {
  stdio: "inherit",
});
console.log(`Built native binary: ${outFile}`);
