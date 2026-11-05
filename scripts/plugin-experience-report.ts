import { readdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pluginLogDir } from '../packages/mica-plugin/PluginLog.js';
import { summarizePluginExperience } from '../packages/mica-plugin/PluginExperienceReport.js';

// Read only. Works with live logs or a copied log directory. No network requests.
const args = process.argv.slice(2);
const values: Record<string, string> = {};
for (let index = 0; index < args.length; index++) {
  const arg = args[index]!;
  if (arg === '--help') {
    console.log(
      'bun scripts/plugin-experience-report.ts [--dir LOG_DIR] [--plugin PLUGIN_ID] [--since ISO_DATE]\nPrints aggregate JSON to stdout; redirect to a file to export.',
    );
    process.exit(0);
  }
  if (!['--dir', '--plugin', '--since'].includes(arg) || !args[index + 1] || args[index + 1]!.startsWith('--'))
    throw new Error(`Invalid argument: ${arg}`);
  values[arg.slice(2)] = args[++index]!;
}
const since = values.since ? Date.parse(values.since) : undefined;
if (since !== undefined && !Number.isFinite(since)) throw new Error('--since must be an ISO date');
const directory = resolve(values.dir ?? pluginLogDir());
let names: string[] = [];
try {
  names = (await readdir(directory)).filter((name) => /^plugin-[A-Za-z0-9._-]+\.jsonl$/.test(name)).sort();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const lines: string[] = [];
for (const name of names) {
  let handle;
  try {
    handle = await open(resolve(directory, name), 'r');
    for await (const line of handle.readLines()) {
      // Avoid retaining conversation/tool logs in the reporting process.
      if (line.includes('"plugin:experience"')) lines.push(line);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  } finally {
    await handle?.close();
  }
}
console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      summaries: summarizePluginExperience(lines, { since, plugin: values.plugin }),
    },
    null,
    2,
  ),
);
