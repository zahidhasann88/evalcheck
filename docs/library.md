# Library and development

## Use as a library

Everything the CLI does is available as a typed ESM API. The library never calls
`process.exit`.

```ts
import { compareRuns, loadBaseline, loadSuite, reportToConsole, runSuite } from 'evalcheck';

const { suite, hash } = await loadSuite('suite.yaml');
const run = await runSuite({ suite, suiteHash: hash, concurrency: 4, repeat: 1 });
console.log(reportToConsole(run));

run.comparison = compareRuns(await loadBaseline('baseline'), run);
```

`runSuite` options include `filter`, `rps`, `minPassRate`, `tag`, `env`, `logger`, `embeddings`,
`onCase`, `record` and `replay` (recordings from `createCassette` and `loadCassette`).
`runSuiteFile(path, options)` loads and runs a suite in one call. `loadSuite` applies
`evalcheck.config.yaml` next to the suite; pass `{ config: false }` to skip it.

Other exports include the reporters (`reportToJson`, `reportToJunit`, `reportToHtml`,
`reportToMarkdown`), `compareVariants`, `buildHistory` with its renderers, `parseThresholds`,
`saveBaseline`, `startMockServer`, `suiteJsonSchema` and the individual graders.
`compareRuns(a, b, { significance: 0.05 })` enables the statistical comparison. See [`src/core/index.ts`](../src/core/index.ts) for the full list.

## Mock endpoint

`evalcheck serve-mock` starts a deterministic endpoint for trying evalcheck without an API
(`--port`, `--host`, `--latency`):

| Route                       | Description                                 |
| --------------------------- | ------------------------------------------- |
| `POST /chat`                | JSON answer with `reply`, `intent`, `confidence` |
| `POST /stream`              | the same answer as a server-sent events stream |
| `POST /v1/chat/completions` | OpenAI Chat Completions shape, with tool calls |
| `POST /v1/messages`         | Anthropic Messages shape, with tool calls   |
| `POST /echo`                | returns the request body                    |
| `GET /health`               | health check                                |

Answers include token usage. The inputs `trigger-500`, `trigger-429` and `trigger-slow` exercise
retries and timeouts, a request to hack someone else's account gets a refusal, and a question
that asks for an answer "auf Deutsch" gets one in German.

## Development

Requires Node.js 22.19 or later and pnpm.

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm build
pnpm test:coverage      # writes an HTML coverage report to coverage/
pnpm test:slow          # also runs the tests that download the embedding model (POSIX shell)
```

With the build in place, `node examples/mock-server.mjs` starts the mock endpoint and the
suites in [`examples/suites`](../examples/suites) run against it.
