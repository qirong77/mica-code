#!/usr/bin/env bun

import dotenv from 'dotenv';
import { resolve } from 'node:path';
import { createApplication } from './app/index.js';
import { reportRuntimeError } from './runtime/uiBridge.js';

process.on('uncaughtException', (error) => {
  reportRuntimeError(error, '未捕获异常');
});

process.on('unhandledRejection', (error) => {
  reportRuntimeError(error, '未处理的异步错误');
});

dotenv.config({ path: resolve(process.cwd(), '.env') });
dotenv.config({ path: resolve(process.cwd(), 'packages/mica-agent/.env') });

const app = createApplication();

await app.start();
await app.waitUntilExit();
await app.stop();
