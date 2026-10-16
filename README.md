# evalcheck

Deterministic regression testing for AI-powered HTTP endpoints.

evalcheck sends test cases to any HTTP endpoint, grades the responses with rule-based checks,
and reports what changed between runs. It never calls an LLM. The only network traffic goes
to your own endpoint.

```bash
npm install -g evalcheck
```

Requires Node.js 20 or later.

## Quick start

Try it with the bundled mock endpoint, no API key needed:

```bash
evalcheck serve-mock          # terminal 1, listens on http://127.0.0.1:8787
evalcheck init demo           # terminal 2, scaffolds an example suite
evalcheck run demo/evalcheck.example.yaml
```

## Suite file

Suites are YAML or JSON. `${ENV_VAR}` reads from the environment, and `{{input}}`,
`{{vars.x}}` and `{{case.id}}` fill in values from the case.

```yaml
name: support-bot

target:
  url: ${API_URL}/chat
  method: POST
  headers:
    Authorization: "Bearer ${API_KEY}"
  body:
    message: "{{input}}"
    user: "{{vars.user}}"
  preset: none                  # openai-chat | anthropic-messages | generic-json | none
  response:
    textPath: "$.reply"         # JSONPath to the answer text (default: whole body)
    stream: false               # false | sse
  timeoutMs: 30000
  retries: { max: 2, on: [429, 5xx, timeout], backoffMs: 500 }

defaults:
  checks:                       # applied to every case
    - type: latency
      maxMs: 5000

cases:
  - id: refund-policy
    input: "What is your refund policy?"
    vars: { user: u1 }
    repeat: 3                   # run 3 times to detect flaky answers
    checks:
      - type: contains
        value: "30 days"
```

Any check can be marked `optional: true` to report it without failing the case.

### Check types

| Type              | Options                                              | Passes when                                   |
| ----------------- | ---------------------------------------------------- | --------------------------------------------- |
| `contains`        | `value`, `caseInsensitive`                           | the text contains `value`                     |
| `not_contains`    | `value`, `caseInsensitive`                           | the text does not contain `value`             |
| `regex`           | `pattern`, `flags`                                   | the pattern matches                           |
| `exact`           | `value`, `normalize` (`trim`, `lowercase`, `collapseWhitespace`, ...) | the normalized text equals `value` |
| `json_schema`     | `schema` (inline) or `schemaFile` / `$ref`           | the extracted JSON is valid                   |
| `json_path`       | `path` + `equals` / `matches` / `exists` / `gte` / `lte` / `contains` | the value at `path` satisfies the operators |
| `length`          | `min`, `max`, `unit` (`chars` or `words`)            | the length is within range                    |
| `latency`         | `maxMs`, `minMs`, `ttftMaxMs` (streaming only)       | the timing is within budget                   |
| `similarity`      | `reference` / `references`, `minScore`               | cosine similarity from a local embedding model reaches `minScore` |
| `lexical_overlap` | `reference` / `references`, `minScore`, `metric` (`f1`, `rougeL`, `jaccard`) | token overlap reaches `minScore` |
| `no_pii`          | `categories` (`email`, `phone`, `card`, `secret`), `allow` | no PII or credentials are found (cards are Luhn-checked) |
| `custom`          | `module`, `export`                                   | your function returns `{ pass: true }`        |

A custom check is a JS or TS module:

```js
export default function check(response, ctx) {
  return { pass: !response.text.includes('PROMO'), reason: 'no promo codes' };
}
```

### Datasets

Cases can also come from a JSONL or CSV file:

```bash
evalcheck run suite.yaml --dataset cases.csv --dataset-input question --dataset-vars user,lang
```

## Commands

```bash
evalcheck run suite.yaml [--out runs] [--format console|json|junit|html] [--repeat 3]
                         [--concurrency 4] [--rps 10] [--filter "refund-*"] [--tag name]
                         [--against baseline] [--fail-on-regression] [--threshold ...]
evalcheck compare runs/a.json runs/b.json [--fail-on-regression] [--threshold ...]
evalcheck baseline save runs/latest.json
evalcheck baseline list | show [name]
evalcheck report runs/latest.json --format html --out report.html
evalcheck validate suite.yaml
evalcheck init [dir]
evalcheck serve-mock [--port 8787]
```

Every run is saved as JSON in `runs/` (with a copy at `runs/latest.json`). Use
`evalcheck <command> --help` to see all options.

### Comparing runs

`compare` (and `run --against`) reports cases that went from pass to fail (regressions), fail to
pass (fixes), newly flaky cases, pass-rate and latency changes, and similarity drift.

Thresholds make the command fail when a metric gets worse by more than the allowed amount:

```bash
--threshold pass_rate=-0.02 --threshold latency_p95=+20% --threshold similarity=-0.05
```

Supported metrics are `pass_rate`, `latency_p50`, `latency_p95` and `similarity`. Values can be
absolute (`-0.02`, `+150ms`) or relative (`+20%`).

### Exit codes

| Code | Meaning                                  |
| ---- | ---------------------------------------- |
| 0    | All checks passed                        |
| 1    | Failed or flaky checks, or a regression  |
| 2    | Configuration error                      |
| 3    | Endpoint unreachable                     |

## CI example

Save a baseline once from a known good state and commit it:

```bash
evalcheck run suites/support-bot.yaml
evalcheck baseline save runs/latest.json      # writes .evalcheck/baseline.json
```

Then compare every pull request against it:

```yaml
- name: Run evalcheck
  env:
    API_URL: ${{ secrets.API_URL }}
    API_KEY: ${{ secrets.API_KEY }}
  run: |
    npx evalcheck run suites/support-bot.yaml \
      --against baseline --fail-on-regression \
      --format junit --out-file runs/junit.xml

- name: HTML report
  if: always()
  run: npx evalcheck report runs/latest.json --format html --out runs/report.html

- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: evalcheck
    path: runs/
```

## Library usage

```ts
import { loadSuite, runSuite, reportToConsole, loadBaseline, compareRuns } from 'evalcheck';

const { suite, hash } = await loadSuite('suite.yaml');
const run = await runSuite({ suite, suiteHash: hash, concurrency: 4 });
console.log(reportToConsole(run));

const comparison = compareRuns(await loadBaseline('baseline'), run);
if (comparison.regressions.length > 0) process.exitCode = 1;
```

The library never calls `process.exit` and never writes to the console.

## What deterministic checks can and cannot catch

They catch missing facts, broken formats, forbidden content, PII leaks, latency regressions,
drift from a reference answer, and unstable answers (with `--repeat`).

They cannot judge factual correctness beyond what you assert, tone, helpfulness, or
hallucinations that don't contradict your checks. Treat them as a floor: they confirm your
written contract still holds.

Recommended combinations:

- **Format:** `json_schema` + `json_path` + `length`
- **Required facts:** one `contains` or `regex` per fact
- **Forbidden content:** `not_contains` + `no_pii`
- **Latency budget:** `latency` with `maxMs` (and `ttftMaxMs` when streaming)
- **Drift:** `similarity` + `lexical_overlap`

## Similarity and embeddings

`similarity` uses a local embedding model via transformers.js. Install it only if you use
this check:

```bash
npm install @huggingface/transformers
```

The default model, `Xenova/paraphrase-multilingual-MiniLM-L12-v2`, is multilingual and
supports Bangla. It is downloaded once, with a notice, and cached in `~/.cache/evalcheck/models`.
With `--offline` nothing is downloaded, and the run fails clearly if the model is missing.

Scores depend on the model and its revision. Use them to detect regressions, not as an
absolute quality measure. Pin `embedding.revision` in the suite, and calibrate `minScore` on
your own data.

## Secrets

Environment values, sensitive headers (`authorization`, `x-api-key`, `cookie`, ...) and common
credential patterns are replaced with `[REDACTED]` in every run file and report.

## Development

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm build
```

## License

MIT
