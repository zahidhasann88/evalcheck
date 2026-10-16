/**
 * A tiny, dependency-free JSONPath subset.
 *
 * Supported syntax:
 *   $                     root
 *   .key / ['key']        child access
 *   [0] / [-1]            array index
 *   [*] / .*              wildcard
 *   ..key                 recursive descent
 *   ..[*]                 recursive descent over all children
 */

export interface JsonPathMatch {
  value: unknown;
  path: string;
}

export class JsonPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonPathError';
  }
}

type Step =
  | { kind: 'child'; name: string }
  | { kind: 'index'; index: number }
  | { kind: 'wildcard' }
  | { kind: 'descend'; name: string | null };

export function parseJsonPath(path: string): Step[] {
  const trimmed = path.trim();
  if (!trimmed.startsWith('$')) {
    throw new JsonPathError(`JSONPath must start with "$": ${path}`);
  }
  const steps: Step[] = [];
  let i = 1;
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (ch === '.') {
      if (trimmed[i + 1] === '.') {
        i += 2;
        if (trimmed[i] === '[') {
          i++;
          if (trimmed[i] === '*') {
            steps.push({ kind: 'descend', name: null });
            i = skipBracket(trimmed, i);
          } else {
            const name = readBracketName(trimmed, i);
            steps.push({ kind: 'descend', name });
            i = skipBracket(trimmed, i);
          }
        } else {
          const name = readName(trimmed, i);
          if (!name) throw new JsonPathError(`Empty property name in JSONPath: ${path}`);
          steps.push({ kind: 'descend', name });
          i += name.length;
        }
      } else {
        i++;
        if (trimmed[i] === '*') {
          steps.push({ kind: 'wildcard' });
          i++;
          continue;
        }
        const name = readName(trimmed, i);
        if (!name) throw new JsonPathError(`Empty property name in JSONPath: ${path}`);
        steps.push({ kind: 'child', name });
        i += name.length;
      }
      continue;
    }
    if (ch === '[') {
      i++;
      if (trimmed[i] === '*') {
        steps.push({ kind: 'wildcard' });
        i = skipBracket(trimmed, i);
        continue;
      }
      if (trimmed[i] === "'" || trimmed[i] === '"') {
        const quote = trimmed[i]!;
        const end = trimmed.indexOf(quote, i + 1);
        if (end === -1) throw new JsonPathError(`Unterminated quoted key in JSONPath: ${path}`);
        const name = trimmed.slice(i + 1, end);
        steps.push({ kind: 'child', name });
        i = skipBracket(trimmed, end + 1);
        continue;
      }
      const close = trimmed.indexOf(']', i);
      if (close === -1) throw new JsonPathError(`Unterminated "[" in JSONPath: ${path}`);
      const raw = trimmed.slice(i, close).trim();
      if (!/^-?\d+$/.test(raw)) {
        throw new JsonPathError(`Unsupported JSONPath index "${raw}" in: ${path}`);
      }
      steps.push({ kind: 'index', index: Number.parseInt(raw, 10) });
      i = close + 1;
      continue;
    }
    if (ch === ' ') {
      i++;
      continue;
    }
    throw new JsonPathError(`Unexpected character "${ch}" in JSONPath: ${path}`);
  }
  return steps;
}

function readName(path: string, start: number): string {
  let i = start;
  while (i < path.length && /[^.[\]]/.test(path[i]!)) i++;
  return path.slice(start, i);
}

function readBracketName(path: string, start: number): string {
  const quote = path[start];
  if (quote !== "'" && quote !== '"') throw new JsonPathError(`Expected quoted key at ${start} in: ${path}`);
  const end = path.indexOf(quote, start + 1);
  if (end === -1) throw new JsonPathError(`Unterminated quoted key in JSONPath: ${path}`);
  return path.slice(start + 1, end);
}

function skipBracket(path: string, start: number): number {
  const close = path.indexOf(']', start);
  if (close === -1) throw new JsonPathError(`Unterminated "]" in JSONPath: ${path}`);
  return close + 1;
}

/** Returns every value matching the path, in document order. */
export function jsonPathQuery(root: unknown, path: string): unknown[] {
  const steps = parseJsonPath(path);
  let current: Array<{ value: unknown; path: string }> = [{ value: root, path: '$' }];

  for (const step of steps) {
    const next: Array<{ value: unknown; path: string }> = [];
    for (const node of current) {
      switch (step.kind) {
        case 'child': {
          if (isRecord(node.value) && step.name in node.value) {
            next.push({ value: node.value[step.name], path: `${node.path}.${step.name}` });
          }
          break;
        }
        case 'index': {
          if (Array.isArray(node.value)) {
            const idx = step.index < 0 ? node.value.length + step.index : step.index;
            if (idx >= 0 && idx < node.value.length) {
              next.push({ value: node.value[idx], path: `${node.path}[${idx}]` });
            }
          }
          break;
        }
        case 'wildcard': {
          if (Array.isArray(node.value)) {
            node.value.forEach((v, i) => next.push({ value: v, path: `${node.path}[${i}]` }));
          } else if (isRecord(node.value)) {
            for (const [k, v] of Object.entries(node.value)) {
              next.push({ value: v, path: `${node.path}.${k}` });
            }
          }
          break;
        }
        case 'descend': {
          collectDescendants(node, step.name, next);
          break;
        }
      }
    }
    current = next;
  }

  return current.map((n) => n.value);
}

export function jsonPathFirst(root: unknown, path: string): unknown {
  const results = jsonPathQuery(root, path);
  return results.length > 0 ? results[0] : undefined;
}

export function jsonPathExists(root: unknown, path: string): boolean {
  return jsonPathQuery(root, path).length > 0;
}

function collectDescendants(
  node: { value: unknown; path: string },
  name: string | null,
  out: Array<{ value: unknown; path: string }>,
): void {
  const value = node.value;
  const children: Array<{ value: unknown; path: string }> = [];

  if (Array.isArray(value)) {
    value.forEach((v, i) => children.push({ value: v, path: `${node.path}[${i}]` }));
  } else if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      children.push({ value: v, path: `${node.path}.${k}` });
    }
  }

  for (const child of children) {
    if (name === null) {
      out.push(child);
    } else if (isRecord(child.value) && name in child.value) {
      out.push({ value: child.value[name], path: `${child.path}.${name}` });
    }
    collectDescendants(child, name, out);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
