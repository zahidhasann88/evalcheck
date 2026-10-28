# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-10-28

### Changed

- Shorter package description, CLI help text and README introduction.

## [0.2.0] - 2026-10-28

### Added

- **Conversations** - a case can use `turns` instead of `input` to send several messages in
  order. Earlier messages are sent as history (`messages` for the `openai-chat` and
  `anthropic-messages` presets, a `history` field for `generic-json`, `{{history}}` in a custom
  body). Each turn has its own checks, case checks run on the final reply, `extract` reads values
  from a response into vars for later turns, and `{{conversation.id}}` / `{{turn.index}}` are
  available in templates.
- **Record and replay** - `evalcheck run --record <file>` saves every response and
  `--replay <file>` grades the saved responses without calling the endpoint. Secrets are
  removed from recordings, `textPath` changes apply on replay, and a warning is shown when a
  request no longer matches the recording.
- **`tool_call` check** - asserts that a response calls a tool, optionally with the expected
  arguments (`args`, partial match), an exact number of calls (`times`) or no call at all
  (`called: false`). Tool calls are read from OpenAI, Anthropic, Gemini and plain `tool_calls`
  responses, or from a custom `path`.
- **Markdown report** - `--format markdown` on `run` and `report`, made for pull request
  comments and the GitHub job summary.
- **GitHub Action** - `uses: zahidhasann88/evalcheck@v1` runs a suite, posts the report as a
  pull request comment (updated in place on every push) and writes it to the job summary.
- **JSON Schema for suite files** - published as `dist/suite.schema.json` (also
  `evalcheck/suite.schema.json` and `evalcheck schema`) for autocomplete and inline errors in
  editors. Suite files may contain a `$schema` key.
- The mock server answers follow-up questions about an order, returns tool calls, and serves
  OpenAI (`/v1/chat/completions`) and Anthropic (`/v1/messages`) shaped endpoints.
- Example suites for conversations and tool calls.
- **`minPassRate`** - a case (or `defaults`, or `--min-pass-rate`) passes when at least this
  share of its repeats pass, instead of being reported as flaky.
- **`any_of`, `all_of` and `not` checks** - combine and invert other checks, nested as deep as
  needed.
- **Token usage and cost** - usage is read from OpenAI, Anthropic and Gemini responses (also
  streamed) or from `target.response.usagePath`, and `target.pricing` turns it into a cost. Usage
  is stored per attempt and in the run totals, shown in every report, compared between runs and
  usable in `tokens` and `cost` thresholds. The new `usage` check sets a token or cost budget.
- **Several suites per run** - `evalcheck run` and `evalcheck validate` accept several suite
  files and directories. Suites share settings through `evalcheck.config.yaml` next to them (or
  `--config`), with its own JSON Schema (`dist/config.schema.json`, `evalcheck schema --config`).
- **`refusal` and `language` checks** - detect refusals such as "I'm sorry, but I can't help with
  that" (or require one with `refused: true`), and check the language of an answer.
- `pnpm test:coverage`, and CI now runs on Windows as well as Linux and reports coverage.
- **Statistical compare** - `--significance 0.05` on `compare` and `run --against` reports a
  regression or fix only when a one-sided Fisher exact test over the repeats is below the level;
  smaller changes are listed as within noise, with a note for cases with too few repeats.
- **A/B testing** - `variants` in a suite override parts of the target; `evalcheck run` runs every
  variant (or `--variant <names>`) and prints a side by side table with pass rate, latency,
  tokens and cost, also in the Markdown report.
- **`evalcheck history`** - pass rate, failures, latency, tokens and cost of every stored run,
  grouped by suite and variant, as a table, Markdown, JSON or an HTML page with charts.

### Security

- Upgraded `zod` to 4.6.7 to pick up the fix for a published memory exhaustion advisory.
- Pinned patched versions of the transitive `fast-uri` (via `ajv`) and, for the optional local
  embedding backend, `sharp`. `pnpm audit` now reports no known vulnerabilities.

### Changed

- **Breaking:** Node.js 22.19 or later is now required (was 20). The CLI and HTTP client
  dependencies (`commander` 15, `undici` 8) no longer support Node 20.
- Upgraded `commander` to 15 and `undici` to 8.
- `@huggingface/transformers` 4 is now accepted as the optional embedding backend
  (3.x keeps working).
- `safeParseSuite` now returns Zod 4's `ZodSafeParseResult`. Config error messages are
  unchanged.

### Fixed

- TypeScript custom checks (`custom` with a `.ts` module) work when TypeScript 7 is installed.
  TypeScript 7 has no JavaScript compiler API, so evalcheck now falls back to the
  `@typescript/typescript6` compatibility package, and the error message says what to install.

## [0.1.0] - 2026-10-15

The first release.

### Added

- **Suite format** - YAML or JSON suites validated with Zod. Unknown keys are rejected and every
  problem is reported with file, line and column.
  - `target` with `url`, `method`, `headers`, `query`, `body`, `timeoutMs` and a `retries` policy
    (`max`, `on` with status codes / `4xx` / `5xx` / `timeout` / `network`, `backoffMs`).
  - Request shape presets `openai-chat`, `anthropic-messages`, `generic-json` and `none`.
  - Response extraction with `textPath` (JSONPath) and SSE streaming with `chunkPath`,
    including time-to-first-token measurement.
  - `defaults` for `repeat`, `checks` and `vars`; per case `vars`, `tags`, `repeat` and `skip`.
- **Twelve deterministic check types** - `contains`, `not_contains`, `regex`, `exact`,
  `json_schema`, `json_path`, `length`, `latency`, `similarity`, `lexical_overlap`, `no_pii`
  and `custom`.
  - `json_schema` supports inline schemas, `schemaFile`, `$ref` and nested external references.
  - `no_pii` detects emails, phone numbers, Luhn valid card numbers and credential patterns.
  - `custom` runs a user supplied JavaScript or TypeScript module.
- **Runner** - concurrency (`--concurrency`), global rate limiting (`--rps`), repeated runs
  (`--repeat`) with per case pass rates and flaky case detection, glob filtering (`--filter`).
- **Datasets** - cases can be loaded from JSONL, NDJSON, CSV or JSON with explicit column mapping.
- **Comparison** - `evalcheck compare` reports regressions, fixes, new and removed cases, the
  overall and per check-type pass rate delta, latency p50/p95 deltas and similarity drift.
  Thresholds support absolute and percentage values (`pass_rate=-0.02`, `latency_p95=+20%`).
- **Baselines** - `evalcheck baseline save|list|show` and `evalcheck run --against <baseline>`.
  `--against` accepts a saved baseline name or a run file path, and every run is also copied to
  `<out>/latest.json`.
- **Reports** - console summary, versioned JSON report, JUnit XML for CI and a self-contained
  single file HTML report with a sortable table, a failing-only filter and expandable response
  diffs.
- **CLI** - `run`, `compare`, `baseline`, `init`, `validate`, `report` and `serve-mock`, with the
  documented exit codes `0` (pass), `1` (failures/regressions), `2` (config error) and
  `3` (endpoint unreachable).
- **Library** - the whole core is importable with a typed API and never calls `process.exit`.
- **Secret handling** - environment values and well known credential shapes are redacted from
  every artifact and report.
- **Local embeddings** - optional `similarity` backend based on `@huggingface/transformers`,
  lazily loaded, pinned by name and revision, cached locally, announced on first use and
  disableable with `--offline`.
- **Examples** - a chatbot suite, a JSON output suite, a streaming suite and
  a bundled mock endpoint.

[Unreleased]: https://github.com/zahidhasann88/evalcheck/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/zahidhasann88/evalcheck/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/zahidhasann88/evalcheck/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/zahidhasann88/evalcheck/releases/tag/v0.1.0
