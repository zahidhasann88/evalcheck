#!/usr/bin/env node
// Same server as `evalcheck serve-mock`. Usage: pnpm build && node examples/mock-server.mjs [--port 8787]
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.join(here, '..', 'dist', 'core', 'index.js');

let startMockServer;
try {
  ({ startMockServer } = await import(distEntry));
} catch {
  console.error('The evalcheck bundle is not built yet. Run "pnpm build" first, or use "pnpm exec evalcheck serve-mock".');
  process.exit(1);
}

const portArg = process.argv.indexOf('--port');
const port = portArg === -1 ? 8787 : Number.parseInt(process.argv[portArg + 1] ?? '8787', 10);

const handle = await startMockServer({ port, host: '127.0.0.1' });

console.log(`evalcheck mock endpoint listening on ${handle.url}`);
console.log(`  chat    POST ${handle.url}/chat`);
console.log(`  stream  POST ${handle.url}/stream`);
console.log(`  echo    POST ${handle.url}/echo`);
console.log(`  health  GET  ${handle.url}/health`);
console.log('\nPress Ctrl+C to stop.');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void handle.close().finally(() => process.exit(0));
  });
}
