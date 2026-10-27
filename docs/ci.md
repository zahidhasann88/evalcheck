# Continuous integration

## GitHub Action

The action runs a suite with `npx evalcheck`, writes the Markdown report to the job summary and
posts it as a pull request comment. The comment is updated on every push instead of adding a
new one.

```yaml
permissions:
  contents: read
  pull-requests: write

jobs:
  evalcheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: zahidhasann88/evalcheck@v1
        env:
          API_URL: ${{ secrets.API_URL }}
          API_KEY: ${{ secrets.API_KEY }}
        with:
          suite: suites/support-bot.yaml
          against: baseline
```

| Input                | Default               | Description                                                 |
| -------------------- | --------------------- | ----------------------------------------------------------- |
| `suite`              | (required)            | suite file, or a directory of suites                        |
| `against`            |                       | baseline name or run file to compare with                   |
| `fail-on-regression` | `true`                | fail when a case regresses (only with `against`)            |
| `args`               |                       | extra `evalcheck run` options, split on spaces, e.g. `--repeat 5 --significance 0.05` |
| `comment`            | `true`                | post the report on the pull request                         |
| `github-token`       | `${{ github.token }}` | token for the comment; needs `pull-requests: write`         |
| `version`            | `latest`              | evalcheck version to run                                    |
| `working-directory`  | `.`                   | directory to run in                                         |

Outputs: `exit-code` (see [exit codes](regressions.md#exit-codes)) and `report` (path of the
Markdown file). The step fails when evalcheck exits with a non-zero code.

To compare against a baseline, commit the baseline file (`.evalcheck/baseline.json` by default)
to the repository.

## Without the action

```yaml
- run: npx evalcheck run suites/support-bot.yaml --against baseline --fail-on-regression --format markdown >> "$GITHUB_STEP_SUMMARY"
```

For CI systems that read JUnit XML, use `--format junit --out-file results.xml`.

## Replay in CI

Commit a recording and grade it on every pull request without an API key:

```yaml
- run: npx evalcheck run suites/support-bot.yaml --replay recordings/support-bot.json
```

See [record and replay](regressions.md#record-and-replay).
