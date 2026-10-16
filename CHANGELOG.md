# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `evalcheck run` keeps a copy of the most recent run at `<out>/latest.json`, so
  `evalcheck baseline save runs/latest.json` works as documented.
- `--against` accepts a saved baseline name (`--against baseline` resolves to
  `.evalcheck/baseline.json`) as well as a run file path.

### Fixed

- The console report was printed twice by `run` and `report`: `reportToConsole` no longer writes
  to stdout itself and only returns the text (pass `write` to receive it).
- `evalcheck baseline show` printed nothing.
- The suite scaffolded by `evalcheck init` failed against the mock endpoint (invalid `(?i)` regex
  and a mismatched `lexical_overlap` reference).
- Sensitive request and response headers (`authorization`, `x-api-key`, `cookie`, ...) are now
  redacted entirely in run files, as documented, even when their value is a literal in the suite.
- Results passed to the `onCase` callback are redacted.
- Percentage thresholds on `similarity` compare the relative change, like the latency metrics.
- `--rps` accepts fractional values (e.g. `0.5`) instead of rounding them down to unlimited.
- GitHub Actions: `cache` / `registry-url` were not nested under `with:`, and the pinned pnpm
  version conflicted with `packageManager`. The smoke test now waits for the mock endpoint.

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
- **Examples** - a chatbot suite, a JSON output suite, a Bangla Q&A suite, a streaming suite and
  a bundled mock endpoint.

[Unreleased]: https://github.com/evalcheck/evalcheck/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/evalcheck/evalcheck/releases/tag/v0.1.0
