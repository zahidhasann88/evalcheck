# Regressions, replay and reports

## Runs

Every `evalcheck run` writes a JSON run file to `runs/<timestamp>_<suite>.json` and a copy to
`runs/latest.json` (change the directory with `--out`). Useful options:

| Option                | What it does                                      |
| --------------------- | ------------------------------------------------- |
| `--filter <glob>`     | run only cases whose id matches                   |
| `--repeat <n>`        | run every case n times                            |
| `--min-pass-rate <r>` | pass a case when this share of repeats passes, e.g. `0.8` |
| `--concurrency <n>`   | cases run in parallel (default 4)                 |
| `--rps <n>`           | limit requests per second (fractions allowed)     |
| `--tag <name>`        | store a label in the run metadata                 |

With `--repeat`, a case that passes in some repeats and fails in others is reported as flaky,
unless a minimum pass rate is set (`--min-pass-rate` or `minPassRate` in the suite): then it
passes or fails depending on whether the share of passing repeats reaches the minimum.

## Running several suites

```bash
evalcheck run suites/                    # every .yaml, .yml and .json file in the directory
evalcheck run suites/billing.yaml suites/safety.yaml
```

Suites in a directory share `evalcheck.config.yaml` ([shared config](suites.md#shared-config)).
With several suites:

- each suite's run files go to `<out>/<suite name>/`, including its own `latest.json`;
- `--record` and `--replay` take a directory with one `<suite name>.json` per suite;
- `--format json` prints an array and `--format markdown` one report per suite;
- the exit code is `3` if any endpoint was unreachable, otherwise `1` if any suite failed;
- `--against` is not available; compare suites one at a time.

## Baselines

Save a known good run and compare later runs with it:

```bash
evalcheck run suite.yaml
evalcheck baseline save runs/latest.json          # stored in .evalcheck/baseline.json
evalcheck run suite.yaml --against baseline --fail-on-regression
```

`baseline save` accepts `--name` and `--dir` (default `.evalcheck`); `baseline list` and
`baseline show [name]` inspect stored baselines. `--against` also accepts a run file path.

Compare any two run files directly:

```bash
evalcheck compare runs/old.json runs/new.json --fail-on-regression --format json
```

The comparison lists regressions, fixes, flaky, new and removed cases, the pass rate change per
check type, latency p50/p95 changes and similarity drift.

### Thresholds

Fail when a metric gets worse by more than a limit, given as an absolute value or a percentage:

```bash
evalcheck run suite.yaml --against baseline --threshold pass_rate=-0.02 --threshold latency_p95=+20%
```

Metrics: `pass_rate`, `latency_p50`, `latency_p95`, `similarity`, `tokens` (mean total tokens
per attempt) and `cost` (mean cost per attempt, needs `target.pricing`). Token and cost changes
are also shown in every comparison when both runs reported usage.

### Ignoring noise

AI answers vary between runs, so a case that passed 9 of 10 repeats yesterday and 8 of 10 today
has probably not changed. `--significance` only reports a regression or fix when a one-sided
Fisher exact test over the repeats says the change is unlikely to be chance:

```bash
evalcheck run suite.yaml --repeat 10 --against baseline --significance 0.05 --fail-on-regression
evalcheck compare runs/old.json runs/new.json --significance 0.05
```

```
✗ order-lookup (-60pp, p=0.005)
~ 1 change(s) within noise (p ≥ 0.05)
  refund-policy (-10pp, p=0.500)
```

Smaller changes are listed as within noise and do not fail the run. A case needs at least 4
repeats in both runs to ever reach p < 0.05; evalcheck prints a note for cases with fewer. Without
`--significance`, every change of status counts.

## A/B testing

Run the same cases against several targets and compare them side by side. Each variant
overrides part of `target` (headers, query and response are merged):

```yaml
target:
  url: ${API_URL}/v1/chat/completions
  preset: openai-chat
  model: gpt-4o-mini
variants:
  current: {}
  candidate:
    model: gpt-4.1-mini
```

```
case               current   candidate
refund-policy      ✔         ✔
order-lookup       ✔         ✗
pass rate          100.0%    50.0%
tokens / attempt   412       298 (-27.7%)

candidate vs current: 1 worse (order-lookup), 0 better
```

- The first variant is the baseline. `--significance` applies to the comparison too.
- Each variant's run files go to `<out>/<suite>/<variant>/`; `--record` and `--replay` use one
  file per variant in the given directory.
- `--variant candidate` (or a comma separated list) runs only those variants, for example to
  compare one of them with a baseline using `--against`.
- `--format markdown` adds the table to the report.

See [`examples/suites/model-comparison.yaml`](../examples/suites/model-comparison.yaml).

## History

`evalcheck history` reads every run file under a directory and shows how each suite changed:

```bash
evalcheck history runs
evalcheck history runs --suite support-bot --limit 30 --format html --out history.html
```

```
history · support-bot
date               pass rate   failed   p95      tokens   run
2026-10-01 09:00   100.0%      0/4      820ms    410      v1.2
2026-10-08 09:00   96.0%       1/4      910ms    455      v1.3
2026-10-15 09:00   92.0%       1/4      1240ms   530      v1.4
3 runs: pass rate 100.0% → 92.0%, p95 820ms → 1240ms, tokens 410 → 530
```

Formats: `console`, `markdown`, `json` and `html` (a single page with charts). Runs are grouped
by suite and variant; `--tag` and the git commit label each run.

## Record and replay

Record the responses once, then grade the recording as often as you like without calling the
endpoint:

```bash
evalcheck run suite.yaml --record recordings/suite.json
evalcheck run suite.yaml --replay recordings/suite.json
```

- Replay needs no network access or API key, which makes it fast and free for writing checks
  and for CI.
- Changes to `textPath` and `chunkPath` apply to the recorded bodies.
- Recorded latency is reused, so `latency` checks keep their meaning.
- A warning is shown when a request no longer matches the recording, for example after
  changing an input. A case without a recorded response fails with a message to record again.
- Secrets and sensitive headers are removed from recordings.

## Reports

`--format` selects the report printed by `run`: `console` (default), `json`, `junit`, `html`
or `markdown`. `console`, `json` and `markdown` go to stdout and `junit` and `html` to a file
next to the run file, unless `--out-file` is given.

Build a report from a stored run with `evalcheck report <run.json> --format html --out report.html`
(`--baseline <run.json>` adds a response diff to the HTML report).

## Exit codes

| Code | Meaning                                                   |
| ---- | --------------------------------------------------------- |
| `0`  | every check passed                                        |
| `1`  | a check failed, a case was flaky, a threshold was exceeded, or a case regressed with `--fail-on-regression` |
| `2`  | configuration error (invalid suite, bad option)           |
| `3`  | the endpoint could not be reached                         |
