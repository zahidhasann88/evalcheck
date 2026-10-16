import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  receivedAt: number;
}

export interface TestServer {
  url: string;
  port: number;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export type TestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
  index: number,
) => void | Promise<void>;

export async function startTestServer(handler: TestHandler): Promise<TestServer> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const index = requests.length;
      requests.push({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body,
        receivedAt: Date.now(),
      });
      void Promise.resolve(handler(req, res, body, index)).catch((err) => {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export function jsonResponse(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** Writes an SSE stream with the given chunks and a small delay between them. */
export async function sseResponse(
  res: ServerResponse,
  chunks: unknown[],
  delayMs = 5,
): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
