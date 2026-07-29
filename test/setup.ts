import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testRoot = process.env.MICA_TEST_ROOT || mkdtempSync(join(tmpdir(), 'mica-tests-'));
const testHome = join(testRoot, 'home');

mkdirSync(testHome, { recursive: true });
process.env.MICA_TEST_ROOT = testRoot;
process.env.MICA_HOME = testHome;
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.XDG_CONFIG_HOME = join(testHome, '.config');
