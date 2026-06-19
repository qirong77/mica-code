import { execSync } from 'node:child_process';

execSync('bunx tsc --noEmit', { stdio: 'inherit' });
