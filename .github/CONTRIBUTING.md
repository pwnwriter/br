# Contributing

`br` is early. Small, focused changes are easier to review than broad rewrites.

## Development

```bash
nix develop
zig build
zig build test
bun run fmt:ts
```

Run with a specific Bun:

```bash
BR_BUN=/path/to/bun ./zig-out/bin/br open https://example.com
```

## Design Constraints

- Keep the agent CLI small and deterministic.
- Do not add Playwright, Puppeteer, Selenium, MCP, AI APIs, a TUI, or a web dashboard.
- Keep `snap` compact. Do not dump the full DOM.
- Prefer structured responses and stable exit codes over English-only errors.
- Keep human terminal rendering separate from agent snapshots.

## Tests

Zig unit tests should cover parser, protocol, session validation, output formatting, and error code behavior.

Browser tests should use local fixtures under `tests/fixtures/`, not public websites.

