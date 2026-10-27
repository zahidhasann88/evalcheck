#!/usr/bin/env node
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command, CommanderError } from 'commander';

import { registerRunCommand } from './run.js';
import { registerCompareCommand } from './compare.js';
import { registerBaselineCommand } from './baseline.js';
import { registerInitCommand } from './init.js';
import { registerValidateCommand } from './validate.js';
import { registerReportCommand } from './report.js';
import { registerServeMockCommand } from './serve-mock.js';
import { registerSchemaCommand } from './schema.js';
import { reportError } from './shared.js';
import { EXIT_CONFIG_ERROR } from '../core/errors.js';

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('evalcheck')
    .description(
      'Deterministic regression testing for AI-powered HTTP endpoints. No LLM calls, no judge models.',
    )
    .version(readVersion())
    .showHelpAfterError()
    .configureOutput({
      writeErr: (str) => process.stderr.write(str),
    });

  registerRunCommand(program);
  registerCompareCommand(program);
  registerBaselineCommand(program);
  registerInitCommand(program);
  registerValidateCommand(program);
  registerReportCommand(program);
  registerServeMockCommand(program);
  registerSchemaCommand(program);

  return program;
}

function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  program.exitOverride((error) => {
    throw error;
  });

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      // --help / --version exit with 0, usage mistakes are configuration errors.
      process.exitCode = error.exitCode === 0 ? 0 : EXIT_CONFIG_ERROR;
      return;
    }
    process.exitCode = reportError(error);
  }
}

const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  void main();
}
