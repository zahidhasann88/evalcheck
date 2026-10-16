import type { Logger } from './types.js';

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export function createLogger(
  level: 'silent' | 'error' | 'warn' | 'info' | 'debug' = 'warn',
  sink: Partial<Record<'debug' | 'info' | 'warn' | 'error', (msg: string) => void>> = {},
): Logger {
  const order = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 } as const;
  const threshold = order[level];
  const make =
    (name: 'debug' | 'info' | 'warn' | 'error') =>
    (message: string, ...args: unknown[]) => {
      if (order[name] > threshold) return;
      const fn = sink[name] ?? (() => {});
      fn(format(message, args));
    };
  return {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
  };
}

function format(message: string, args: unknown[]): string {
  if (args.length === 0) return message;
  return `${message} ${args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ')}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
