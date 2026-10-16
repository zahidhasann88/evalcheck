import { Command } from 'commander';

import { startMockServer } from '../core/mock/server.js';

export function registerServeMockCommand(program: Command): Command {
  return program
    .command('serve-mock')
    .description('Start the bundled mock endpoint so you can try evalcheck without an API')
    .option('--port <port>', 'port to listen on', '8787')
    .option('--host <host>', 'host to bind to', '127.0.0.1')
    .option('--latency <ms>', 'artificial latency for every response', '0')
    .action(async (options: { port?: string; host?: string; latency?: string }) => {
      const port = Number.parseInt(options.port ?? '8787', 10);
      const latencyMs = Number.parseInt(options.latency ?? '0', 10);
      const handle = await startMockServer({
        port: Number.isFinite(port) ? port : 8787,
        host: options.host ?? '127.0.0.1',
        latencyMs: Number.isFinite(latencyMs) ? latencyMs : 0,
      });

      process.stdout.write(`evalcheck mock endpoint listening on ${handle.url}\n`);
      process.stdout.write(`  chat    POST ${handle.url}/chat\n`);
      process.stdout.write(`  stream  POST ${handle.url}/stream\n`);
      process.stdout.write(`  echo    POST ${handle.url}/echo\n`);
      process.stdout.write(`  health  GET  ${handle.url}/health\n`);
      process.stdout.write('\nPress Ctrl+C to stop.\n');

      const shutdown = (): void => {
        void handle.close().finally(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
}
