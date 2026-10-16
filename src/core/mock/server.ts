/**
 * Deterministic mock endpoint used by `evalcheck serve-mock`.
 *
 *   GET /health   POST /chat   POST /stream (SSE)   POST /echo
 *
 * The inputs "trigger-500", "trigger-429" and "trigger-slow" (2s delay) exercise
 * the retry and timeout paths.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface MockServerOptions {
  port?: number;
  host?: string;
  /** Delay applied to every response (ms). */
  latencyMs?: number;
}

export interface MockServerHandle {
  server: Server;
  port: number;
  host: string;
  url: string;
  close(): Promise<void>;
}

interface ChatAnswer {
  intent: string;
  reply: string;
  confidence: number;
  sources: string[];
}

const ANSWERS: Array<{ match: RegExp; answer: ChatAnswer }> = [
  {
    match: /refund|return|ফেরত|রিফান্ড/i,
    answer: {
      intent: 'refund_policy',
      reply:
        'Refunds are available within 30 days of purchase. To request a refund, open a support ticket with your order number and we will process it within 3 business days.',
      confidence: 0.93,
      sources: ['kb://refund-policy', 'kb://billing-faq'],
    },
  },
  {
    match: /hello|hi|hey|হাজি|সালাম|হ্যালো/i,
    answer: {
      intent: 'greeting',
      reply: 'Hello! I am the support bot. Ask me about refunds, shipping or your account.',
      confidence: 0.88,
      sources: ['kb://greetings'],
    },
  },
  {
    match: /বাংলা|bangla|shipping|ডেলিভারি/i,
    answer: {
      intent: 'shipping',
      reply:
        'ডেলিভারি সাধারণত ২-৩ কর্মদিবসে সম্পন্ন হয়। বাংলাদেশের ভেতরে ডেলিভারি ফ্রি, এবং অর্ডার ট্র্যাক করতে ট্র্যাকিং নম্বর ব্যবহার করুন।',
      confidence: 0.9,
      sources: ['kb://shipping-bn'],
    },
  },
  {
    match: /password|otp|2fa|login/i,
    answer: {
      intent: 'account_security',
      reply:
        'Never share passwords or OTPs. Support will never ask for them. You can reset your password from Settings > Security.',
      confidence: 0.95,
      sources: ['kb://security'],
    },
  },
];

const DEFAULT_ANSWER: ChatAnswer = {
  intent: 'general',
  reply:
    'Thanks for your question. Based on our knowledge base the answer is: your request has been recorded and a support specialist will follow up within one business day.',
  confidence: 0.72,
  sources: ['kb://general'],
};

export function answerFor(input: string): ChatAnswer {
  for (const entry of ANSWERS) {
    if (entry.match.test(input)) return entry.answer;
  }
  return { ...DEFAULT_ANSWER, reply: `${DEFAULT_ANSWER.reply} (question: ${input})` };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function parseJsonBody(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return { input: raw };
}

function extractInput(body: Record<string, unknown>): string {
  const candidates = [body.message, body.input, body.text, body.prompt, body.content, body.question];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  if (Array.isArray(body.messages)) {
    const last = body.messages[body.messages.length - 1] as { content?: unknown } | undefined;
    if (last && typeof last.content === 'string') return last.content;
  }
  return '';
}

/** Creates the mock server (not yet listening). */
export function createMockServer(options: MockServerOptions = {}): Server {
  return createServer((req, res) => {
    void handle(req, res, options.latencyMs ?? 0);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, latencyMs: number): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, service: 'evalcheck-mock' });
  }

  const raw = await readBody(req);
  const body = parseJsonBody(raw);
  const input = extractInput(body);

  if (input === 'trigger-500') {
    return sendJson(res, 500, { error: 'internal error (triggered by the mock server)' });
  }
  if (input === 'trigger-429') {
    res.setHeader('retry-after', '0');
    return sendJson(res, 429, { error: 'too many requests (triggered by the mock server)' });
  }
  if (input === 'trigger-slow') {
    await delay(2000);
  } else if (latencyMs > 0) {
    await delay(latencyMs);
  }

  if (url.pathname === '/echo') {
    return sendJson(res, 200, { echo: body, ok: true });
  }

  if (url.pathname === '/stream') {
    return sendStream(res, input);
  }

  if (url.pathname === '/chat' || url.pathname === '/') {
    const answer = answerFor(input);
    return sendJson(res, 200, {
      reply: answer.reply,
      intent: answer.intent,
      confidence: answer.confidence,
      sources: answer.sources,
      tokens: answer.reply.split(/\s+/).length,
    });
  }

  return sendJson(res, 404, { error: `unknown route ${url.pathname}` });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sendStream(res: ServerResponse, input: string): void {
  const answer = answerFor(input);
  const words = answer.reply.split(/(\s+)/).filter((part) => part !== '');
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  let index = 0;
  const timer = setInterval(() => {
    if (index >= words.length) {
      res.write('data: [DONE]\n\n');
      clearInterval(timer);
      res.end();
      return;
    }
    const chunk = words[index]!;
    index += 1;
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: chunk }, index: 0 }] })}\n\n`,
    );
  }, 15);
  timer.unref?.();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export async function startMockServer(options: MockServerOptions = {}): Promise<MockServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const server = createMockServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8787, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : (options.port ?? 8787);
  return {
    server,
    port,
    host,
    url: `http://${host}:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
