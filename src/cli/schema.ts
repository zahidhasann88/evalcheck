import { Command } from 'commander';

import { configJsonSchema, suiteJsonSchema } from '../core/config/json-schema.js';
import { writeArtifact } from './shared.js';

export function registerSchemaCommand(program: Command): Command {
  return program
    .command('schema')
    .description('Print the JSON Schema of the suite format (for editor autocomplete and validation)')
    .option('--config', 'print the schema of evalcheck.config.yaml instead')
    .option('--out <file>', 'write the schema to a file instead of stdout')
    .action(async (options: { config?: boolean; out?: string }) => {
      const schema = options.config ? configJsonSchema() : suiteJsonSchema();
      const content = `${JSON.stringify(schema, null, 2)}\n`;
      if (options.out) {
        process.stdout.write(`${await writeArtifact(options.out, content)}\n`);
      } else {
        process.stdout.write(content);
      }
    });
}
