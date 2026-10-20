# evalcheck

Test your AI endpoint like you test normal code.

## What is this?

If your app uses AI (a chatbot, a support bot, an API that returns AI answers),
its answers can quietly change when you edit a prompt or switch models.
Usually you only find out when a user complains.

evalcheck catches this early. You write down some questions and the rules a good
answer must follow. evalcheck asks your API those questions and checks every answer.

## How it works

```
 suite.yaml            your API              evalcheck
 ───────────           ────────              ─────────
 questions   ──────▶   answers    ──────▶    checks rules ──▶ pass / fail
 + rules                                     compares with last good run
```

1. **You write a test file** with questions and rules, for example:
   "What is your refund policy?" → answer must contain "30 days".
2. **evalcheck sends each question** to your API, just like a real user.
3. **It checks each answer** against your rules (contains a word, valid JSON,
   fast enough, no leaked emails or phone numbers, and more).
4. **It shows what changed** since your last good run, so you see right away
   what broke.

## Install

Requires Node.js 20 or later.

```bash
npm install -g evalcheck
```

## Try it in 1 minute

No API key needed. Open two terminals:

```bash
# terminal 1: start a fake AI endpoint
evalcheck serve-mock

# terminal 2: create an example test and run it
evalcheck init demo
evalcheck run demo/evalcheck.example.yaml
```

## Write a test

Create a file called `suite.yaml`:

```yaml
name: support-bot

target:
  url: ${API_URL}/chat            # ${...} reads environment variables
  method: POST
  headers:
    Authorization: "Bearer ${API_KEY}"
  body:
    message: "{{input}}"          # {{input}} is replaced with each case's input
  response:
    textPath: "$.reply"           # where the answer is in the JSON response

cases:
  - id: refund-policy
    input: "What is your refund policy?"
    checks:
      - type: contains
        value: "30 days"
      - type: latency
        maxMs: 5000
```

Run it:

```bash
evalcheck run suite.yaml
```

## Checks

| Check             | Passes when                                     |
| ----------------- | ----------------------------------------------- |
| `contains`        | the answer contains some text                   |
| `not_contains`    | the answer does not contain some text           |
| `regex`           | the answer matches a pattern                    |
| `exact`           | the answer is exactly some text                 |
| `json_schema`     | the answer is valid JSON for a schema           |
| `json_path`       | a value inside the JSON answer is correct       |
| `length`          | the answer is not too short or too long         |
| `latency`         | the answer arrives fast enough                  |
| `no_pii`          | no emails, phone numbers, cards or secrets leak |
| `lexical_overlap` | the answer uses similar words to a reference    |
| `similarity`      | the answer means the same as a reference \*     |
| `custom`          | your own JS/TS function returns `{ pass: true }` |

\* `similarity` needs an extra package: `npm install @huggingface/transformers`.
It runs a small model on your machine (downloaded once).

Run `evalcheck validate suite.yaml` to check your file for mistakes.

## Catch regressions

Save a "known good" run, then compare future runs against it:

```bash
evalcheck run suite.yaml
evalcheck baseline save runs/latest.json

# later, after changing your prompt or model:
evalcheck run suite.yaml --against baseline --fail-on-regression
```

evalcheck shows which cases broke, which got fixed, and how speed changed.

## Commands

| Command                              | What it does                         |
| ------------------------------------ | ------------------------------------ |
| `evalcheck run suite.yaml`           | run the tests                        |
| `evalcheck validate suite.yaml`      | check the suite file for errors      |
| `evalcheck compare a.json b.json`    | compare two runs                     |
| `evalcheck baseline save <run.json>` | save a run as the baseline           |
| `evalcheck report <run.json> --format html --out report.html` | make an HTML report |
| `evalcheck init [dir]`               | create an example suite              |
| `evalcheck serve-mock`               | start a fake endpoint for testing    |

Add `--help` to any command to see all options. Results are saved in `runs/`.

Exit code is `0` when everything passes, `1` when something fails, `2` for a config
error and `3` when the endpoint can't be reached, so it works in CI out of the box.

More examples are in the [`examples/`](examples) folder.

## Use in GitHub Actions

```yaml
- name: Run evalcheck
  env:
    API_URL: ${{ secrets.API_URL }}
    API_KEY: ${{ secrets.API_KEY }}
  run: npx evalcheck run suites/support-bot.yaml --against baseline --fail-on-regression
```

## Use as a library

```ts
import { loadSuite, runSuite, reportToConsole } from 'evalcheck';

const { suite, hash } = await loadSuite('suite.yaml');
const run = await runSuite({ suite, suiteHash: hash });
console.log(reportToConsole(run));
```

## Good to know

- API keys and auth headers are replaced with `[REDACTED]` in all saved results.
- Rule-based checks catch broken formats, missing facts, leaks and slowdowns. They can't
  judge tone or helpfulness, so think of them as a safety net, not a full review.

## Development

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm build
```

## License

MIT
