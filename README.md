# 🏷️ Issue Triage

A GitHub Action that **triages every new issue** — applies labels, flags likely duplicates, and assigns the right people. Stateless: it recomputes from the repo's open issues each run, so there's **no server and no vector store**.

Part of [DevGuard Tools](https://ivosetyadi.github.io). Zero-dependency, Node 20, no bundling.

## What it does

1. **Auto-label** — matches the title/body against keyword rules (e.g. `bug`, `enhancement`, `question`, `documentation`, `security`).
2. **Duplicate detection** — compares the new issue to open issues and comments `possible-duplicate` with the closest matches. Lexical similarity by default; **real embeddings if you supply a key (BYOK)**.
3. **Auto-assign** — assigns people based on a label→assignee map.

## Usage

```yaml
# .github/workflows/issue-triage.yml
name: Issue Triage
on:
  issues:
    types: [opened, edited]
permissions:
  issues: write
jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: ivosetyadi/issue-triage@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## Config — `.issuetriage.yml` (optional)

```yaml
duplicate-threshold: 0.6     # 0..1, higher = stricter
comment: true
labels:                      # extends the built-in rules
  bug: oops, borked, stack trace
  performance: slow, lag, timeout
assignees:                   # label -> who gets assigned
  security: ivosetyadi
```

### Embedding-based duplicates (optional)

```yaml
      - uses: ivosetyadi/issue-triage@v1
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          base-url: https://api.openai.com/v1   # or any compatible endpoint
          embed-model: text-embedding-3-small
```

Without a key, duplicate detection uses token-level cosine similarity — no external calls.

## Outputs

- `labels` — labels applied
- `duplicates` — issue numbers flagged

## License

MIT © Ivo Setyadi
