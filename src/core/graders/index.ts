import type { CheckType, Grader, GraderRegistry } from '../types.js';
import { containsGrader, exactGrader, lengthGrader, notContainsGrader, regexGrader } from './text.js';
import { jsonSchemaGrader } from './json-schema.js';
import { jsonPathGrader } from './json-path.js';
import { latencyGrader } from './latency.js';
import { lexicalOverlapGrader } from './lexical.js';
import { noPiiGrader } from './pii.js';
import { similarityGrader } from './similarity.js';
import { customGrader } from './custom.js';
import { toolCallGrader } from './tool-call.js';

export const graders: GraderRegistry = {
  contains: containsGrader,
  not_contains: notContainsGrader,
  regex: regexGrader,
  exact: exactGrader,
  json_schema: jsonSchemaGrader,
  json_path: jsonPathGrader,
  length: lengthGrader,
  latency: latencyGrader,
  similarity: similarityGrader,
  lexical_overlap: lexicalOverlapGrader,
  no_pii: noPiiGrader,
  custom: customGrader,
  tool_call: toolCallGrader,
};

export function getGrader(type: CheckType): Grader {
  const grader = graders[type];
  if (!grader) {
    throw new Error(`Unknown check type "${type}"`);
  }
  return grader;
}

export { containsGrader, notContainsGrader, regexGrader, exactGrader, lengthGrader };
export { jsonSchemaGrader, jsonPathGrader, latencyGrader, lexicalOverlapGrader, noPiiGrader, similarityGrader, customGrader };
export { toolCallGrader };
export { cosineSimilarity } from './embedding/local.js';
export { detectPii } from './pii.js';
export type { PiiFinding } from './pii.js';
