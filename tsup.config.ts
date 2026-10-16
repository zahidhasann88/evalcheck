import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'core/index': 'src/core/index.ts',
    'cli/index': 'src/cli/index.ts',
  },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  external: ['@huggingface/transformers'],
});
