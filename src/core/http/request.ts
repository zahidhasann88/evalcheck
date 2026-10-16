import type { CaseSpec, RequestPreset, Suite, TargetSpec } from '../types.js';
import type { Interpolator, TemplateScope } from '../utils/interpolate.js';

export interface BuiltRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  /** Human readable description of how the body was assembled. */
  bodySource: string;
}

export interface BuildRequestOptions {
  suite: Suite;
  caseSpec: CaseSpec;
  interpolator: Interpolator;
  scope: TemplateScope;
}

export function buildRequest(options: BuildRequestOptions): BuiltRequest {
  const { suite, caseSpec, interpolator, scope } = options;
  const target = suite.target;

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(target.headers ?? {})) {
    headers[key] = interpolator.string(value, scope);
  }

  let query = '';
  if (target.query && Object.keys(target.query).length > 0) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(target.query)) {
      params.append(key, interpolator.string(value, scope));
    }
    query = `?${params.toString()}`;
  }

  const url = `${interpolator.string(target.url, scope)}${query}`;

  const presetBody = buildPresetBody(target.preset, target, caseSpec, scope);
  let body: unknown;
  let bodySource: string;

  if (target.body !== undefined) {
    const userBody = interpolator.deep(target.body, scope);
    if (presetBody && isPlainObject(userBody) && isPlainObject(presetBody)) {
      body = { ...presetBody, ...userBody };
      bodySource = `preset:${target.preset} + suite body`;
    } else {
      body = userBody;
      bodySource = 'suite body';
    }
  } else if (presetBody) {
    body = presetBody;
    bodySource = `preset:${target.preset}`;
  } else {
    body = undefined;
    bodySource = 'none';
  }

  if (body !== undefined && !hasHeader(headers, 'content-type')) {
    headers['content-type'] = 'application/json';
  }

  return {
    method: target.method,
    url,
    headers,
    ...(body !== undefined ? { body } : {}),
    bodySource,
  };
}

function buildPresetBody(
  preset: RequestPreset,
  target: TargetSpec,
  caseSpec: CaseSpec,
  scope: TemplateScope,
): Record<string, unknown> | undefined {
  const input = scope.input ?? caseSpec.input ?? '';
  switch (preset) {
    case 'none':
      return undefined;
    case 'openai-chat': {
      const body: Record<string, unknown> = {
        messages: [{ role: 'user', content: input }],
      };
      if (target.model) body.model = target.model;
      if (target.maxTokens !== undefined) body.max_tokens = target.maxTokens;
      if (target.temperature !== undefined) body.temperature = target.temperature;
      if (target.system) body.messages = [{ role: 'system', content: target.system }, ...(body.messages as unknown[])];
      return body;
    }
    case 'anthropic-messages': {
      const body: Record<string, unknown> = {
        max_tokens: target.maxTokens ?? 1024,
        messages: [{ role: 'user', content: input }],
      };
      if (target.model) body.model = target.model;
      if (target.temperature !== undefined) body.temperature = target.temperature;
      if (target.system) body.system = target.system;
      return body;
    }
    case 'generic-json': {
      const body: Record<string, unknown> = { input };
      for (const [key, value] of Object.entries(caseSpec.vars ?? {})) {
        if (key === 'input') continue;
        body[key] = value;
      }
      return body;
    }
    default:
      return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}
