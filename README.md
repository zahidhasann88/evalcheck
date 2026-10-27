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

Requires Node.js 22.19 or later.

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
| `tool_call`       | the answer calls a tool with the right arguments |

\* `similarity` needs an extra package: `npm install @huggingface/transformers`.
It runs a small model on your machine (downloaded once).

Run `evalcheck validate suite.yaml` to check your file for mistakes.

### Autocomplete in your editor

Add this line at the top of a suite file to get autocomplete, hover help and inline
errors in VS Code (with the YAML extension) and other editors:

```yaml
# yaml-language-server: $schema=https://unpkg.com/evalcheck/dist/suite.schema.json
```

For JSON suites, add `"$schema": "https://unpkg.com/evalcheck/dist/suite.schema.json"`.
`evalcheck schema --out suite.schema.json` writes the schema to a local file instead.

## Test a conversation

Chatbots often break on the second or third message. Use `turns` instead of `input`
to send a conversation. Each message is sent with the earlier ones as history:

```yaml
cases:
  - id: refund-follow-up
    turns:
      - input: "I want a refund"
        checks:
          - type: contains
            value: "order number"
      - input: "My order is #4821"
        checks:
          - type: contains
            value: "#4821"
    checks:                       # case checks run on the final reply
      - type: contains
        value: "3 business days"
```

- With `preset: openai-chat` or `anthropic-messages`, the history is sent as `messages`.
  With `preset: generic-json`, it is sent as a `history` field.
- In your own `body`, use `"{{history}}"` (the list of earlier messages),
  `{{conversation.id}}` (one id per conversation, for APIs that keep sessions) and
  `{{turn.index}}`.
- `extract` reads a value from a response for later messages:

  ```yaml
  turns:
    - input: "Where is my order #4821?"
      extract:
        orderId: "$.order.id"
    - input: "Please cancel order #{{vars.orderId}}"
  ```

## Check tool calls

If your AI calls tools (functions), check which tool it calls and with which arguments:

```yaml
checks:
  - type: tool_call
    name: get_weather
    args:                 # only these keys are compared, other arguments are allowed
      city: Dhaka
  - type: tool_call
    name: delete_account
    called: false         # this tool must never be called
```

Tool calls are found automatically in OpenAI, Anthropic and Gemini responses and in a
plain `tool_calls` list. For other shapes, point `path` at the list (for example
`path: "$.result.actions"`). Use `times: 2` to require an exact number of calls.

## Record once, replay for free

Calling a real model costs money and takes time. Record the answers once, then
re-run the checks against the recording as often as you like:

```bash
evalcheck run suite.yaml --record recordings/support-bot.json
evalcheck run suite.yaml --replay recordings/support-bot.json
```

Replay never calls your API, so it is instant and needs no API key. It is the fastest
way to write and tune checks, and lets CI check the suite on every pull request.
Changes to `textPath` apply to the recorded answers. When a request no longer matches
the recording (for example you changed an input), evalcheck warns you to record again.
API keys and auth headers are removed from recordings.

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
| `evalcheck schema`                   | print the JSON Schema of suite files |
| `evalcheck serve-mock`               | start a fake endpoint for testing    |

Reports come in `console`, `json`, `junit`, `html` and `markdown` format
(`--format markdown`).

Add `--help` to any command to see all options. Results are saved in `runs/`.

Exit code is `0` when everything passes, `1` when something fails, `2` for a config
error and `3` when the endpoint can't be reached, so it works in CI out of the box.

More examples are in the [`examples/`](examples) folder.

## Use in GitHub Actions

The evalcheck action runs a suite and posts the result as a comment on the pull
request. The comment is updated on every push instead of adding a new one.

```yaml
permissions:
  pull-requests: write

steps:
  - uses: actions/checkout@v4
  - uses: zahidhasann88/evalcheck@v1
    env:
      API_URL: ${{ secrets.API_URL }}
      API_KEY: ${{ secrets.API_KEY }}
    with:
      suite: suites/support-bot.yaml
      against: baseline           # optional: compare with a saved baseline
```

| Input                | Default  | What it does                                         |
| -------------------- | -------- | ---------------------------------------------------- |
| `suite`              |          | the suite file to run                                |
| `against`            |          | baseline name or run file to compare with            |
| `fail-on-regression` | `true`   | fail the step when a case regresses                  |
| `args`               |          | extra `evalcheck run` options, e.g. `--repeat 3`     |
| `comment`            | `true`   | post the report on the pull request                  |
| `version`            | `latest` | evalcheck version to run                             |

The report is also added to the job summary. Without the action:

```yaml
- run: npx evalcheck run suites/support-bot.yaml --against baseline --fail-on-regression --format markdown >> "$GITHUB_STEP_SUMMARY"
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
