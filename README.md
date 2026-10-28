# evalcheck

Repeatable test suites for AI endpoints. evalcheck sends your test cases to any HTTP API,
grades every answer with deterministic, rule-based checks and reports what changed since the
last good run.

## Install

Requires Node.js 22.19 or later.

```bash
npm install -g evalcheck
```

## Quick start

```bash
evalcheck serve-mock                       # terminal 1: a mock endpoint, no API key needed
evalcheck init demo                        # terminal 2: an example suite
evalcheck run demo/evalcheck.example.yaml
```

## Write a suite

```yaml
# yaml-language-server: $schema=https://unpkg.com/evalcheck/dist/suite.schema.json
name: support-bot
target:
  url: ${API_URL}/chat                 # ${...} reads environment variables
  headers:
    Authorization: "Bearer ${API_KEY}"
  body:
    message: "{{input}}"
  response:
    textPath: "$.reply"                # where the answer is in the JSON response
cases:
  - id: refund-policy
    input: "What is your refund policy?"
    checks:
      - type: contains
        value: "30 days"
      - type: no_pii
      - type: latency
        maxMs: 5000
```

Run `evalcheck validate suite.yaml` to check the file, then `evalcheck run suite.yaml`.

Checks: `contains`, `not_contains`, `regex`, `exact`, `json_schema`, `json_path`, `length`,
`latency`, `no_pii`, `refusal`, `language`, `usage` (token and cost budgets), `lexical_overlap`,
`similarity` (local embedding model), `tool_call`, `custom` (your own JS/TS function), and
`any_of` / `all_of` / `not` to combine them. The [suite reference](docs/suites.md) covers every
field, presets, streaming, retries, repeats with `minPassRate`, templates, datasets and the shared
`evalcheck.config.yaml`. Cases can also hold multi-turn conversations: see
[conversations and tool calls](docs/conversations-and-tools.md).

Run every suite in a directory with `evalcheck run suites/`.

## Catch regressions

```bash
evalcheck baseline save runs/latest.json
evalcheck run suite.yaml --against baseline --fail-on-regression
evalcheck run suite.yaml --record rec.json # save the responses once
evalcheck run suite.yaml --replay rec.json # re-grade them without calling the API
evalcheck run suite.yaml --repeat 10 --against baseline --significance 0.05  # ignore noise
evalcheck history runs --format html --out history.html                      # trends over time
```

Exit codes: `0` pass, `1` failures or regressions, `2` config error, `3` endpoint unreachable.
[Regressions, replay and reports](docs/regressions.md) covers thresholds, statistical compare,
A/B testing of models or prompts with `variants`, history, and the `console`, `json`, `junit`,
`html` and `markdown` reports.

## GitHub Actions

```yaml
- uses: zahidhasann88/evalcheck@v1
  env:
    API_URL: ${{ secrets.API_URL }}
    API_KEY: ${{ secrets.API_KEY }}
  with:
    suite: suites/support-bot.yaml
    against: baseline
```

Posts the report on the pull request and in the job summary. See [CI](docs/ci.md) for inputs.

## Security

- Environment values, API keys and sensitive headers are replaced with `[REDACTED]` in run
  files, reports and recordings.
- Only your endpoint is called. The optional `similarity` model is downloaded once from
  Hugging Face; `--offline` prevents downloads.

[Library API, mock endpoint and development](docs/library.md) · [Examples](examples/suites) ·
[Changelog](CHANGELOG.md) · License: [MIT](LICENSE)
