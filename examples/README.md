# evalcheck examples

This folder contains ready to run example suites and a mock endpoint.

## 1. Start the mock endpoint

```bash
pnpm build
node examples/mock-server.mjs          # or: pnpm exec evalcheck serve-mock
```

The mock endpoint is deterministic and needs no API key:

| Route              | Description                                        |
| ------------------ | -------------------------------------------------- |
| `POST /chat`       | Support bot answers (JSON)                         |
| `POST /stream`     | The same answers as an SSE stream                  |
| `POST /echo`       | Echoes the request body back                       |
| `GET  /health`     | Health probe                                       |

Special inputs let you exercise the failure paths:

| Input          | Behaviour                                |
| -------------- | ---------------------------------------- |
| `trigger-500`  | Responds with HTTP 500                   |
| `trigger-429`  | Responds with HTTP 429                   |
| `trigger-slow` | Responds after a two second delay        |

## 2. Run the example suites

```bash
# chatbot checks
pnpm exec evalcheck run examples/suites/support-bot.yaml

# structured output checks
pnpm exec evalcheck run examples/suites/json-output.yaml

# Bangla question answering (unicode aware)
pnpm exec evalcheck run examples/suites/bangla-qa.yaml

# streaming responses with a time to first token budget
pnpm exec evalcheck run examples/suites/streaming.yaml

# write a self contained HTML report
pnpm exec evalcheck run examples/suites/support-bot.yaml --format html --out runs/support.html
```

## 3. Compare two runs

```bash
pnpm exec evalcheck run examples/suites/support-bot.yaml --out runs/
pnpm exec evalcheck run examples/suites/support-bot.yaml --out runs/
pnpm exec evalcheck compare runs/<first>.json runs/<second>.json --fail-on-regression
```

## Datasets

Cases can also come from a CSV or JSONL file:

```bash
pnpm exec evalcheck run examples/suites/support-bot.yaml \
  --dataset examples/datasets/cases.csv \
  --dataset-id key --dataset-input question --dataset-vars user
```
