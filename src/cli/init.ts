import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Command } from 'commander';

import { ensureDir } from './shared.js';

export function registerInitCommand(program: Command): Command {
  return program
    .command('init')
    .description('Scaffold an example suite (and a custom check module) in a directory')
    .argument('[dir]', 'target directory', '.')
    .option('--force', 'overwrite existing files')
    .action(async (dir: string, options: { force?: boolean }) => {
      const target = await ensureDir(dir);
      await writeIfMissing(path.join(target, 'evalcheck.example.yaml'), EXAMPLE_SUITE, options.force);
      await mkdir(path.join(target, 'checks'), { recursive: true });
      await writeIfMissing(path.join(target, 'checks', 'no-promo-code.mjs'), EXAMPLE_CUSTOM_CHECK, options.force);
      await writeIfMissing(path.join(target, 'README.md'), EXAMPLE_README, options.force);

      process.stdout.write(`Created example files in ${target}\n\n`);
      process.stdout.write('Try it out:\n');
      process.stdout.write('  1) evalcheck serve-mock\n');
      process.stdout.write('  2) evalcheck run evalcheck.example.yaml\n\n');
    });
}

async function writeIfMissing(file: string, content: string, force?: boolean): Promise<void> {
  const { access } = await import('node:fs/promises');
  if (!force) {
    try {
      await access(file);
      process.stdout.write(`skipped (already exists): ${file}\n`);
      return;
    } catch {
      /* file does not exist */
    }
  }
  await writeFile(file, content, 'utf8');
  process.stdout.write(`created: ${file}\n`);
}

const EXAMPLE_SUITE = `name: example-support-bot
description: Example suite that runs against the bundled mock server (evalcheck serve-mock)

target:
  url: http://127.0.0.1:8787/chat
  method: POST
  headers:
    content-type: application/json
  body:
    message: "{{input}}"
    user: "{{vars.user}}"
  response:
    textPath: "$.reply"

defaults:
  repeat: 1
  checks:
    - type: json_path
      id: has-confidence
      path: "$.confidence"
      gte: 0.5
    - type: latency
      id: latency-budget
      maxMs: 2000

cases:
  - id: refund-policy
    input: "What is your refund policy?"
    vars:
      user: u1
    checks:
      - type: contains
        id: mentions-30-days
        value: "30 days"
      - type: not_contains
        id: no-legal-advice
        value: "guaranteed"
      - type: length
        id: not-too-long
        min: 20
        max: 600

  - id: greeting
    input: "hello there"
    vars:
      user: u2
    checks:
      - type: regex
        id: greets
        pattern: "hello|hi "
        flags: "i"
      - type: lexical_overlap
        id: close-enough
        reference: "Hello! I am the support bot. How can I help you?"
        minScore: 0.2

  - id: bangla-shipping
    input: "ডেলিভারি কত দিনে পাব?"
    vars:
      user: u3
    checks:
      - type: contains
        id: mentions-days
        value: "কর্মদিবস"
      - type: no_pii
        id: no-pii
        categories: [email, phone, card]
`;

const EXAMPLE_CUSTOM_CHECK = `/**
 * Example custom check.
 *
 * A custom check exports a function that receives the response and the case
 * context and returns a verdict. It must be deterministic.
 */
export default function noPromoCode(response, ctx) {
  const banned = ['promo', 'discount code', 'coupon'];
  const text = (response.text || '').toLowerCase();
  const hit = banned.find((needle) => text.includes(needle));
  return {
    pass: !hit,
    score: hit ? 0 : 1,
    reason: hit
      ? \`response mentions "\${hit}" (case \${ctx.case.id})\`
      : 'no promotional content found',
  };
}
`;

const EXAMPLE_README = `# evalcheck example

This directory was created by \`evalcheck init\`.

## Run it

\`\`\`bash
# terminal 1 - start the bundled mock endpoint
evalcheck serve-mock

# terminal 2 - run the example suite
evalcheck run evalcheck.example.yaml
\`\`\`

## What the suite shows

- \`contains\` / \`not_contains\` - required and forbidden facts
- \`json_path\` - structured fields of the response
- \`latency\` - a latency budget
- \`length\` - a size budget
- \`lexical_overlap\` - a cheap, model-free similarity check
- \`no_pii\` - the response must not leak personal data
- \`checks/no-promo-code.mjs\` - a custom check written in plain JavaScript
`;
