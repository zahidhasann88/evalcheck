/**
 * `${VAR}` / `${VAR:-default}` are read from a caller-supplied environment, never from
 * `process.env` directly. Values taken from the environment are recorded as secrets.
 */

/** Placeholder written in place of a redacted secret. */
export const REDACTION_PLACEHOLDER = '[REDACTED]';

export interface TemplateScope {
  input?: string;
  vars?: Record<string, unknown>;
  case?: { id: string; [key: string]: unknown };
  /** Earlier messages of a conversation. */
  history?: Array<{ role: string; content: string }>;
  conversation?: { id: string };
  turn?: { index: number };
}

export interface Interpolator {
  string(value: string, scope?: TemplateScope): string;
  deep<T>(value: T, scope?: TemplateScope): T;
  /** Secret values discovered while interpolating. */
  readonly secrets: ReadonlySet<string>;
  /** True when the value came from the environment (i.e. should be redacted). */
  isSecret(value: string): boolean;
}

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
const TEMPLATE_PATTERN = /\{\{([^}]+)\}\}/g;
const HISTORY_ONLY = /^\{\{\s*history\s*\}\}$/;

export interface InterpolatorOptions {
  env?: Record<string, string | undefined>;
  /** Values that must always be treated as secret, even if not env-derived. */
  extraSecrets?: string[];
}

export function createInterpolator(options: InterpolatorOptions = {}): Interpolator {
  const env = options.env ?? {};
  const secrets = new Set<string>();
  for (const value of options.extraSecrets ?? []) {
    if (value && value.length >= 4) secrets.add(value);
  }

  const isSecret = (value: string): boolean => secrets.has(value);

  const interpolateString = (input: string, scope: TemplateScope = {}): string => {
    const withEnv = input.replace(ENV_PATTERN, (_match, name: string, fallback?: string) => {
      const raw = env[name];
      const value = raw !== undefined && raw !== '' ? raw : fallback;
      if (value === undefined) return '';
      if (raw !== undefined && raw !== '') {
        if (value.length >= 4) secrets.add(value);
      }
      return value;
    });

    return withEnv.replace(TEMPLATE_PATTERN, (_match, expr: string) => {
      const key = expr.trim();
      const resolved = resolveTemplate(key, scope);
      if (typeof resolved === 'string') return resolved;
      if (resolved === undefined || resolved === null) return '';
      try {
        return JSON.stringify(resolved);
      } catch {
        return String(resolved);
      }
    });
  };

  const deep = <T,>(value: T, scope: TemplateScope = {}): T => {
    if (typeof value === 'string') {
      if (HISTORY_ONLY.test(value)) return (scope.history ?? []) as unknown as T;
      return interpolateString(value, scope) as unknown as T;
    }
    if (Array.isArray(value)) return value.map((v) => deep(v, scope)) as unknown as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = deep(v, scope);
      }
      return out as unknown as T;
    }
    return value;
  };

  return {
    string: interpolateString,
    deep,
    secrets,
    isSecret,
  };
}

function resolveTemplate(key: string, scope: TemplateScope): unknown {
  const [head, ...rest] = key.split('.');
  switch (head) {
    case 'input':
      return rest.length === 0 ? scope.input : undefined;
    case 'vars': {
      if (rest.length === 0) return scope.vars;
      return getPath(scope.vars, rest);
    }
    case 'case': {
      if (rest.length === 0) return scope.case;
      return getPath(scope.case, rest);
    }
    case 'history':
      return rest.length === 0 ? scope.history : undefined;
    case 'conversation':
      return getPath(scope.conversation, rest);
    case 'turn':
      return getPath(scope.turn, rest);
    default:
      return undefined;
  }
}

function getPath(root: unknown, path: string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Interpolates `${VAR}` in an arbitrary string using `process.env`.
 * Convenience wrapper used by the CLI layer.
 */
export function interpolateEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(ENV_PATTERN, (_match, name: string, fallback?: string) => {
    const raw = env[name];
    if (raw !== undefined && raw !== '') return raw;
    return fallback ?? '';
  });
}
