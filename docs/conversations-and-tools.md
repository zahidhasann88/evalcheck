# Conversations and tool calls

## Conversations

Use `turns` instead of `input` to send several messages in order. Each message is sent with
the earlier ones as history.

```yaml
cases:
  - id: refund-follow-up
    turns:
      - input: "I want a refund"
        checks:                 # run on the reply to this message
          - type: contains
            value: "order number"
      - input: "My order is #4821"
    checks:                     # case checks run on the final reply
      - type: contains
        value: "3 business days"
```

How the history is sent:

- `preset: openai-chat` and `anthropic-messages`: as earlier entries in `messages`.
- `preset: generic-json`: as a `history` field next to `input`.
- A custom `body`: wherever you put `"{{history}}"` (a list of `{ role, content }` objects).

`{{conversation.id}}` is the same for every turn of one conversation and different for each
repeat, which suits APIs that keep a session. `{{turn.index}}` starts at 1.

`extract` reads values from a response (JSONPath) into vars for the next turns. Turn inputs
can use templates:

```yaml
turns:
  - input: "Where is my order #4821?"
    extract:
      orderId: "$.order.id"
  - input: "Please cancel order #{{vars.orderId}}"
```

Turn checks are reported as `turn-<n>.<check id>`. If a turn fails to get a response, the
rest of the conversation is skipped and the case fails. Defaults checks run on the final reply.

See [`examples/suites/conversation.yaml`](../examples/suites/conversation.yaml).

## Tool calls

The `tool_call` check asserts which tool (function) a response calls:

```yaml
checks:
  - type: tool_call
    name: get_weather
    args:                 # only these keys are compared; other arguments are allowed
      city: Dhaka
    times: 1              # optional: exact number of matching calls
  - type: tool_call
    name: delete_account
    called: false         # this tool must not be called
  - type: tool_call
    called: false         # no tool may be called
```

Tool calls are read from the whole response body. These shapes are detected automatically:

| API                      | Location                                   |
| ------------------------ | ------------------------------------------ |
| OpenAI Chat Completions  | `choices[].message.tool_calls`             |
| OpenAI Responses         | `output[]` items of type `function_call`   |
| Anthropic Messages       | `content[]` blocks of type `tool_use`      |
| Gemini                   | `candidates[].content.parts[].functionCall` |
| Plain                    | `tool_calls[]` with `name` and `arguments` |

For any other shape, set `path` to a JSONPath that points at the list of calls, for example
`path: "$.result.actions"`. Arguments given as a JSON string are parsed first. Streamed tool
calls are not supported.

See [`examples/suites/tool-calls.yaml`](../examples/suites/tool-calls.yaml).
