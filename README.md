# br

A tiny browser CLI built for agents.

```bash
$ br open https://example.com
$ br snap --compact

Example Domain | https://example.com/
@1 link More information...
```

`br` turns a browser page into a compact semantic snapshot with stable `@refs`, then lets an agent act on those refs:

```text
browser -> semantic snapshot -> tiny @refs -> agent actions
```

The agent automation surface is not Playwright, Puppeteer, Selenium, MCP, a TUI, or a web dashboard. `br live` is a separate experimental human mode for visual debugging.

## Why `br`

`br` is not trying to be a full terminal browser. It is trying to be a small agent interface for browser work.

Compared with a terminal browser like `terminal-browser`, `br` keeps the scope narrower:

- Zig owns the CLI, daemon, and protocol.
- Bun WebView owns the browser backend.
- Kitty graphics are only the terminal rendering transport for `br live` and `br view`.
- `br snap` is the primary interaction model, not a full browser UI.
- Stable `@refs` and JSONL batch mode are first-class, so agents can do more with less context.

The result is a thinner stack and a smaller command surface. The tradeoff is that `br` does not aim to match every browser feature or terminal integration a full browser product may offer.

## Status

Experimental, early, and usable for local testing. The browser backend targets Bun's experimental `Bun.WebView` API, so behavior can change as Bun changes.

## Repository Description

Use this as the GitHub repo description:

```text
A tiny browser CLI for AI agents: semantic snapshots, stable @refs, JSONL batch mode, and Bun WebView automation.
```

Suggested topics:

```text
browser-automation, ai-agents, cli, zig, bun, webview, jsonl, terminal, kitty-graphics
```

## Install

Requirements:

- Zig 0.16+
- Bun 1.4+ with `Bun.WebView`
- Prettier for TypeScript formatting
- macOS WebKit backend today; other Bun WebView backends are experimental

From a checkout:

```bash
nix develop
zig build
export BR_BUN="$(command -v bun)"
./zig-out/bin/br open https://example.com
```

Format TypeScript with Bun:

```bash
bun run fmt:ts
```

With Nix packaging:

```bash
nix build
./result/bin/br open https://example.com
```

If you use a downloaded Bun binary:

```bash
export BR_BUN="$PWD/.tools/bun-darwin-aarch64/bun"
```

For packaged installs, set `BR_WORKER_DIR` to the installed `worker/` directory unless your package wrapper does it.

## Quickstart

```bash
br open https://example.com/login
br snap

br fill @2 "user@example.com"
br fill @3 "$PASSWORD"
br click @4

br snap --compact
```

If a ref is stale, `br` fails loudly:

```text
STALE_REF @4
```

Run `br snap` again and use the new ref.

## Batch Mode

Agents should prefer `batch` for multi-step flows:

```bash
br batch <<'JSONL'
{"command":"open","url":"https://example.com"}
{"command":"snapshot","compact":true}
{"command":"click","target":"@4"}
{"command":"snapshot","compact":true}
JSONL
```

Batch mode returns one JSON object per input line and never runs shell commands.

## Commands

```text
open <url>
snap | snapshot [--compact]
click <ref|selector>
fill <ref|selector> <text>
type <text>
press <key>
hover <ref|selector>
text [ref|selector]
html [ref|selector]
get <ref|selector>
attr <ref|selector> <attribute>
value <ref|selector>
find <text>
scroll <amount>
scroll-to <ref|selector>
url
title
back
forward
reload
wait <selector|duration-ms>
eval <javascript>
screenshot [path] [--format png|jpeg|webp] [--quality 0-100]
view
resize <width> <height>
cookies
console
close
```

Admin:

```text
session list
session close <name>
session close-all
daemon status
daemon stop
```

Human terminal browser mode:

```bash
br live https://example.com
```

## Sessions

The default session is `default`.

```bash
br --session github open https://github.com
br --session github snap

br session list
br session close github
br session close-all
```

`br` starts a persistent Bun worker automatically and communicates over JSONL through a Unix socket under `$XDG_RUNTIME_DIR/br/`, falling back to `$TMPDIR/br-runtime/`.

## Profiles

Profiles preserve supported browser state through Bun's `dataStore` option.

```bash
br --profile github open https://github.com
```

Profiles are stored under `~/.local/share/br/profiles/`. Session and profile names are limited to `[A-Za-z0-9_.-]`.

## JSON

Every meaningful command supports `--json`.

```bash
br --json click @4
```

```json
{"ok":true,"command":"click","url":"https://example.com/dashboard"}
```

STDOUT contains only JSON in JSON mode. Diagnostics go to STDERR.

## Terminal View

`br view` renders a one-shot viewport image using the Kitty graphics protocol:

```bash
br open https://example.com
br view
```

`br live [url]` starts an experimental persistent terminal browser shell:

```bash
br live https://example.com
```

Controls:

```text
click          browser click
typing         browser text input
j / k          scroll down / up
Space          page down
tab            switch tabs
t              prompt for new tab URL or search text
o / g          prompt to open URL or search text in current tab
x              close tab
:open <url>    navigate
:reload        reload
:back          back
:forward       forward
:debug-input   show raw input bytes in status line
q              quit
```

Trackpad scroll forwarding depends on the terminal. Keyboard scrolling is the reliable path today.

## Exit Codes

```text
0  SUCCESS
2  INVALID_ARGUMENTS
10 BROWSER_UNAVAILABLE
11 NAVIGATION_FAILED
12 ELEMENT_NOT_FOUND
13 STALE_REF
14 TIMEOUT
15 EVALUATION_FAILED
16 PROTOCOL_ERROR
70 INTERNAL_ERROR
```

## Agent Instructions

```text
Use br for browser interaction.

1. br open <url>
2. Run br snap --compact.
3. Interact using @refs.
4. Run another snap after navigation or major DOM changes.
5. If STALE_REF occurs, snap again.
6. Prefer br batch when performing several actions.
```

## Development

```bash
nix develop
zig build
zig build test
```

Run with a specific Bun:

```bash
BR_BUN=/path/to/bun ./zig-out/bin/br open https://example.com
```

See [`.github/ARCHITECTURE.md`](.github/ARCHITECTURE.md) and [`.github/AGENTS.md`](.github/AGENTS.md).

## Limitations

- Bun WebView is experimental.
- `br live` is for humans and debugging, not agent context.
- Snapshots intentionally omit most DOM details.
- Trackpad scroll forwarding varies by terminal.
- The integration test suite is still small.
