# Agent Usage

Use `br` for browser interaction.

```bash
br open <url>
br snap --compact
```

Interact with refs:

```bash
br click @4
br fill @7 "hello@example.com"
br press Enter
br snap --compact
```

If a ref is stale:

```text
STALE_REF @7
```

Run `br snap --compact` again and use the new ref.

Prefer batch mode for multi-step work:

```bash
br batch <<'JSONL'
{"command":"open","url":"https://example.com/login"}
{"command":"snapshot","compact":true}
{"command":"fill","target":"@1","text":"me@example.com"}
{"command":"press","key":"Enter"}
{"command":"snapshot","compact":true}
JSONL
```

Rules of thumb:

- Use `snap --compact` first.
- Use `get @ref` for one element instead of another full snapshot.
- Use `find "text"` when the desired label is known.
- Use `--json` when branching on results.
- Do not parse terminal graphics or `live` output.

