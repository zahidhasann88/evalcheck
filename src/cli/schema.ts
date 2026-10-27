import { Command } from 'commander';

import { suiteJsonSchema } from '../core/config/json-schema.js';
import { writeArtifact } from './shared.js';

export function registerSchemaCommand(program: Command): Command {
  return program
    .command('schema')
    .description('Print the JSON Schema of the suite format (for editor autocomplete and validation)')
    .option('--out <file>', 'write the schema to a file instead of stdout')
    .action(async (options: { out?: string }) => {
      const content = `${JSON.stringify(suiteJsonSchema(), null, 2)}\n`;
      if (options.out) {
        process.stdout.write(`${await writeArtifact(options.out, content)}\n`);
      } else {
        process.stdout.write(content);
      }
    });
}
