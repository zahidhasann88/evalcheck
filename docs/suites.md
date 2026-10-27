# Suite reference

A suite is a YAML or JSON file. Run `evalcheck validate suite.yaml` to check it without
calling the endpoint. Unknown keys are rejected, and errors point to the line and column.

## Editor autocomplete

Add this line at the top of a YAML suite to get autocomplete and inline errors in editors
that use the YAML language server (for example VS Code with the YAML extension):

```yaml
# yaml-language-server: $schema=https://unpkg.com/evalcheck/dist/suite.schema.json
```

In a JSON suite, add `"$schema": "https://unpkg.com/evalcheck/dist/suite.schema.json"`.
`evalcheck schema --out suite.schema.json` writes the schema to a local file. The shared config
file has its own schema: `https://unpkg.com/evalcheck/dist/config.schema.json`
(`evalcheck schema --config`).

## Shared config

Suites in the same directory can share settings through `evalcheck.config.yaml` (or `.yml`,
`.json`) placed next to them. It accepts `target`, `defaults` and `embedding`:

```yaml
# evalcheck.config.yaml
target:
  url: ${API_URL}/v1/chat/completions
  preset: openai-chat
  headers:
    Authorization: "Bearer ${API_KEY}"
  response:
    textPath: "$.choices[0].message.content"
defaults:
  checks:
    - type: refusal
```

- A suite may then leave out `target`, or set only the fields it changes.
- Suite values win. `headers`, `query`, `response` and `vars` are merged key by key, and the
  shared `defaults.checks` run before the suite's own.
- Paths in the config (for example a `custom` module) are relative to the config file.
- `--config <file>` uses another file. `evalcheck run suites/` runs every suite in a directory;
  see [running several suites](regressions.md#running-several-suites).

See [`examples/project`](../examples/project).

## Top level

| Key           | Description                                                        |
| ------------- | ------------------------------------------------------------------ |
| `name`        | suite name (required)                                              |
| `description` | free text                                                          |
| `target`      | the endpoint to call (required)                                    |
| `defaults`    | `repeat`, `checks` and `vars` applied to every case                |
| `cases`       | the test cases                                                     |
| `embedding`   | model for the `similarity` check: `model`, `revision`, `modelPath`, `cacheDir` |
| `variants`    | named target overrides for [A/B testing](regressions.md#ab-testing)  |

## Target

```yaml
target:
  url: ${API_URL}/chat               # required
  method: POST                       # default POST
  headers: { Authorization: "Bearer ${API_KEY}" }
  query: { lang: en }
  body: { message: "{{input}}" }
  preset: none                       # none | openai-chat | anthropic-messages | generic-json
  model: gpt-4o-mini                 # used by the presets
  system: You are a support bot.     # used by the presets
  maxTokens: 512                     # used by the presets (anthropic-messages defaults to 1024)
  temperature: 0
  pricing:                           # USD (or any currency) per million tokens, for cost tracking
    inputPerMillion: 0.15
    outputPerMillion: 0.6
  response:
    textPath: "$.reply"              # JSONPath to the answer; the whole body when omitted
    stream: sse                      # read a server-sent events stream
    chunkPath: "$.choices[0].delta.content"  # text of each SSE event, joined together
    status: 200                      # expected status; any 2xx when omitted
    usagePath: "$.meta.usage"        # token usage object, when it is not found automatically
  timeoutMs: 30000                   # default 30000
  retries:
    max: 2                           # 0-10
    on: [429, 5xx, timeout]          # status codes, 4xx, 5xx, timeout, network
    backoffMs: 500                   # doubled after every retry
```

Presets build the request body for common APIs:

- `openai-chat`: `{ model, messages, max_tokens, temperature }` with an optional system message.
- `anthropic-messages`: `{ model, max_tokens, system, messages, temperature }`.
- `generic-json`: `{ input, ...vars }`.

When a preset and `body` are both set, the two objects are merged and `body` wins.
Streaming responses also record the time to first token.

Token usage is read automatically from OpenAI, Anthropic and Gemini responses (including
streams) and stored with every attempt; with `pricing`, the cost is computed too. Use the
`usage` check to set a budget and the `tokens` and `cost` [thresholds](regressions.md#thresholds)
to catch increases.

## Cases

```yaml
defaults:
  repeat: 1
  vars: { user: u1 }
  checks:                    # added to every case
    - type: latency
      maxMs: 5000

cases:
  - id: refund-policy        # letters, digits, dot, underscore and dash
    description: The refund window must be mentioned.
    input: "What is your refund policy?"
    vars: { user: u2 }
    tags: [billing]
    repeat: 10               # 1-100
    minPassRate: 0.8         # pass when at least 8 of 10 repeats pass
    skip: false
    checks:
      - type: contains
        value: "30 days"
```

A case uses either `input` or `turns`. See [conversations and tool calls](conversations-and-tools.md).

Without `minPassRate`, a case passes only when every repeat passes, and is reported as flaky
when some repeats fail. With `minPassRate` (also in `defaults` or `--min-pass-rate`), the case
passes when the share of passing repeats reaches the minimum and fails otherwise.

## Templates

| Template                       | Value                                                  |
| ------------------------------ | ------------------------------------------------------ |
| `${VAR}`, `${VAR:-fallback}`   | environment variable (its value is redacted from results) |
| `{{input}}`                    | the case input                                         |
| `{{vars.name}}`                | a case variable (objects are inserted as JSON)         |
| `{{case.id}}`                  | the case id                                            |
| `{{history}}`, `{{conversation.id}}`, `{{turn.index}}` | conversation values         |

## Checks

Every check accepts `id`, `description` and `optional: true` (a failure is reported but does
not fail the case). Checks are rule-based: they catch broken formats, missing facts, leaks and
slowdowns, but they do not judge tone or helpfulness.

| Type              | Fields                                                                   |
| ----------------- | ------------------------------------------------------------------------ |
| `contains`        | `value`, `caseInsensitive`                                               |
| `not_contains`    | `value`, `caseInsensitive`                                               |
| `regex`           | `pattern`, `flags`                                                       |
| `exact`           | `value`, `normalize` (`trim`, `lowercase`, `uppercase`, `collapseWhitespace`, `removePunctuation`) |
| `json_schema`     | `schema` (inline), `schemaFile` or `$ref` (paths relative to the suite)  |
| `json_path`       | `path` and one or more of `equals`, `matches`, `exists`, `gte`, `lte`, `contains` |
| `length`          | `min`, `max`, `unit` (`chars` default, or `words`)                       |
| `latency`         | `maxMs`, `minMs`, `ttftMaxMs` (streaming only)                           |
| `no_pii`          | `categories` (`email`, `phone`, `card`, `secret`), `allow`               |
| `lexical_overlap` | `reference` or `references`, `minScore` (default 0.6), `metric` (`f1` default, `rougeL`, `jaccard`) |
| `similarity`      | `reference` or `references`, `minScore` (default 0.8), `model`, `revision`, `modelPath` |
| `tool_call`       | `name`, `args`, `called`, `times`, `path`; see [tool calls](conversations-and-tools.md#tool-calls) |
| `refusal`         | `refused` (default `false`: the answer must not refuse), `phrases`       |
| `language`        | `expected`: a two-letter code or a list, e.g. `en` or `[en, de]`         |
| `usage`           | `maxInputTokens`, `maxOutputTokens`, `maxTotalTokens`, `maxCost`         |
| `any_of`          | `checks`: passes when at least one passes                                |
| `all_of`          | `checks`: passes when all pass                                           |
| `not`             | `check`: passes when it fails                                            |
| `custom`          | `module`, `export`                                                       |

### Combining checks

`any_of`, `all_of` and `not` hold other checks and can be nested:

```yaml
checks:
  - type: any_of
    checks:
      - type: contains
        value: "30 days"
      - type: contains
        value: "one month"
  - type: not
    check:
      type: regex
      pattern: "guarantee"
      flags: i
```

### `refusal` and `language`

`refusal` looks for common English refusal phrasings such as "I'm sorry, but I can't",
"I cannot provide" or "I must decline". Add your own with `phrases`. Use `refused: true` to
require a refusal, for example for requests the bot must turn down.

`language` first identifies the writing system and, for Latin script, counts common words.
Detected codes: `en`, `es`, `fr`, `de`, `it`, `pt`, `nl`, `ru`, `uk`, `el`, `ar`, `fa`, `he`,
`hi`, `th`, `ko`, `ja` and `zh`. Very short answers cannot be detected and fail.

### `similarity`

Runs a small embedding model on your machine. Install the optional package first:

```bash
npm install @huggingface/transformers
```

The default model is `Xenova/paraphrase-multilingual-MiniLM-L12-v2`. It is downloaded on first
use and cached in `~/.cache/evalcheck/models`. Change this with `embedding` in the suite or
`--embedding-model`, `--embedding-revision` and `--embedding-cache`. `--offline` never downloads.

### `custom`

A JavaScript or TypeScript module that exports a function (the default export, or the name in
`export`). The path is relative to the suite file.

```js
export default function noPromoCode(response, ctx) {
  const hit = /coupon|promo/i.test(response.text);
  return { pass: !hit, score: hit ? 0 : 1, reason: hit ? `promo text in ${ctx.case.id}` : 'ok' };
}
```

`response` has `text`, `json`, `status`, `latencyMs`, `ttftMs` and `attempt`; `ctx` has `case`,
`suite`, `attempt`, `check` and `logger`. TypeScript modules need `typescript` installed
(with TypeScript 7, also `@typescript/typescript6`).

## Datasets

Load extra cases from a `.jsonl`, `.ndjson`, `.csv` or `.json` file:

```bash
evalcheck run suite.yaml --dataset examples/datasets/cases.csv \
  --dataset-id key --dataset-input question --dataset-vars user,lang
```

Other flags: `--dataset-checks <column>` (a JSON array of checks) and
`--dataset-tags <column>` (comma separated). Without `--dataset-vars`, every remaining column
becomes a variable. The suite's `defaults.checks` apply to dataset cases.
