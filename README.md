<div align="center">

<img src=".github/assets/banner.svg" alt="br — a browser CLI built for agents" width="820">

<br>

[![CI](https://img.shields.io/github/actions/workflow/status/pwnwriter/br/ci.yml?branch=main&style=flat-square&label=ci&labelColor=0B0F17&color=2DD4BF&logo=github)](https://github.com/pwnwriter/br/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-2DD4BF?style=flat-square&labelColor=0B0F17)](LICENSE)
[![Zig](https://img.shields.io/badge/Zig-0.16%2B-F7A41D?style=flat-square&labelColor=0B0F17&logo=zig&logoColor=F7A41D)](https://ziglang.org)
[![Bun](https://img.shields.io/badge/Bun-1.4%2B-E9D8C3?style=flat-square&labelColor=0B0F17&logo=bun&logoColor=E9D8C3)](https://bun.sh)
[![Platform](https://img.shields.io/badge/macOS%20·%20Linux-93A2B5?style=flat-square&labelColor=0B0F17)](#install)
[![Status](https://img.shields.io/badge/status-experimental-EAB308?style=flat-square&labelColor=0B0F17)](#status)

</div>

---

**`br` turns a web page into a compact, semantic snapshot with stable `@refs` — then lets you (or an agent) act on those refs.** No Playwright, no Selenium, no huge DOM dumps. Just a tiny command surface built for minimal context.

```console
$ br open https://example.com
$ br snap --compact

Example Domain | https://example.com/
@1 link  More information...
```

That's the whole model:

```text
browser  →  snapshot  →  @refs  →  actions
```

## Why br?

- **Small by design.** Not a terminal browser or a full automation framework — a thin agent interface. Zig owns the CLI and protocol; Bun's WebView owns the browser.
- **Stable `@refs`.** Every interactive element gets a short, reusable handle. If one goes stale, `br` fails loudly with `STALE_REF` instead of clicking the wrong thing.
- **Batch-native.** Multi-step flows run as JSONL in one shot, so agents do more with less back-and-forth.
- **Visual when you want it.** `br view` and `br live` render the real page inline via the Kitty graphics protocol.

## Usage

> **If it renders in a browser, `br` turns it into commands — same page, whether you're an agent, a human, or hunting bugs.**

<details>
<summary><b>🤖 As an AI agent</b> — a browser without the DOM firehose</summary>

<br>

Give your agent a browser without drowning it in DOM. It reads a compact snapshot, acts on `@refs`, and branches on exit codes — no Playwright, no flaky selectors, no 50k-token HTML dumps.

```bash
br batch <<'JSONL'
{"command":"open","url":"https://app.example.com/login"}
{"command":"snapshot","compact":true}
{"command":"fill","target":"@2","text":"user@example.com"}
{"command":"fill","target":"@3","text":"hunter2"}
{"command":"click","target":"@4"}
{"command":"snapshot","compact":true}
JSONL
```

One JSON line in, one out. Stable handles, deterministic exit codes (`STALE_REF`, `TIMEOUT`, …), and `--json` on everything — everything an agent needs to loop reliably.

</details>

<details>
<summary><b>🧑‍💻 As a human</b> — a browser you can pipe</summary>

<br>

Inspect a page, fill a form, grab a screenshot, or read it inline — without leaving the terminal or writing a script.

```bash
br open https://news.ycombinator.com
br snap --compact            # scan the interactive elements
br find "login"              # locate a control by text
br screenshot shot.png       # grab evidence
br view                      # render the viewport inline (Kitty graphics)
br live https://github.com   # full interactive terminal browser
```

Great for quick checks, demos, scraping one page, or driving a site from a shell script.

</details>

<details>
<summary><b>🛡️ For bug bounty & recon</b> — scriptable, pipeable triage</summary>

<br>

A scriptable, headful browser is a fast triage tool — map inputs, read client-side state, and run JS in page context, all pipeable into your recon pipeline. **On targets you're authorized to test.**

```bash
br --profile target open https://app.example.com/account
br snap                                              # every interactive element + its attrs
br eval 'document.cookie'                            # inspect session/CSRF state
br eval '[...document.querySelectorAll("input[type=hidden]")].map(i => [i.name, i.value])'
br attr @5 href                                      # pull hrefs, tokens, data-* attrs
br cookies                                           # dump cookies
br console                                            # surface client-side JS errors
br --backend chrome cdp Network.enable               # Chrome DevTools Protocol (Chromium only)
br screenshot finding.png                            # capture proof for the report
```

Keep separate authenticated contexts with `--profile`, script repeatable checks across params/endpoints with `batch`, and drive it all from the same tools as the rest of your recon.

</details>

> `cdp` needs the Chromium backend — pick it per command with `--backend chrome` (the default `webkit` backend has no CDP). See [Backends](#backends).

## Install

You'll need:

- **Zig** 0.16+
- **Bun** 1.4+ (with `Bun.WebView` — WebKit by default, Chromium via `--backend chrome`)

```bash
# with Nix (recommended)
nix develop
zig build
export BR_BUN="$(command -v bun)"
./zig-out/bin/br open https://example.com

# or build the packaged version
nix build
./result/bin/br open https://example.com
```

> Using a downloaded Bun? Point `br` at it with `export BR_BUN=/path/to/bun`.
> For packaged installs, set `BR_WORKER_DIR` to the installed `worker/` directory.

## Quickstart

Log in to a page in five commands:

```bash
br open https://example.com/login
br snap                      # list the interactive elements + their @refs

br fill @2 "user@example.com"
br fill @3 "$PASSWORD"
br click @4

br snap --compact            # see where you landed
```

Stale ref? `br` tells you plainly — just snapshot again and use the fresh ref:

```text
STALE_REF @4
```

## Batch mode

For anything multi-step, prefer `batch` — one JSON object in per line, one out. It never runs shell commands.

```bash
br batch <<'JSONL'
{"command":"open","url":"https://example.com"}
{"command":"snapshot","compact":true}
{"command":"click","target":"@1"}
{"command":"snapshot","compact":true}
JSONL
```

## Common commands

| Command | What it does |
| --- | --- |
| `open <url>` | Navigate to a page |
| `snap [--compact]` | Semantic snapshot with `@refs` |
| `click <ref\|selector>` | Click an element |
| `fill <ref> <text>` | Focus, clear, and type into a field |
| `type <text>` / `press <key>` | Send keystrokes |
| `find <text>` | Search the current refs |
| `get <ref>` | Inspect a single element |
| `screenshot [path]` | Save a PNG |
| `view` | Render the viewport inline (Kitty graphics) |
| `live [url]` | Interactive terminal browser (for humans) |

<details>
<summary><b>Full command reference</b></summary>

```text
open <url>
snap | snapshot [--compact]
click <ref|selector>          fill <ref|selector> <text>
type <text>                   press <key>              hover <ref|selector>
text [ref|selector]           html [ref|selector]      get <ref|selector>
attr <ref|selector> <attr>    value <ref|selector>     find <text>
scroll <amount>               scroll-to <ref|selector>
url                           title                    back | forward | reload
wait <selector|ms>            eval <javascript>
screenshot [path] [--format png|jpeg|webp] [--quality 0-100]
view                          resize <width> <height>  cookies    console
close

# admin
session list | close <name> | close-all
daemon status | stop
```

Every meaningful command supports `--json` (stdout is pure JSON; diagnostics go to stderr).

</details>

## Sessions & profiles

The default session is `default`. Name others to keep separate browser contexts:

```bash
br --session github open https://github.com
br --session github snap
br session list
br session close github
```

Profiles persist browser state across runs (stored under `~/.local/share/br/profiles/`):

```bash
br --profile github open https://github.com
```

Session and profile names are limited to `[A-Za-z0-9_.-]`.

## Backends

`Bun.WebView` can drive more than one engine. Pick one per command with `--backend`:

```bash
br --backend chrome open https://example.com   # Chromium
br --backend webkit open https://example.com   # WebKit (default)
```

| Backend | Notes |
| --- | --- |
| `webkit` | Default. Available everywhere `Bun.WebView` is (macOS WebKit today). |
| `chrome` | Chromium engine — required for `cdp` (Chrome DevTools Protocol). |

The backend is fixed when a session's browser is first created, so set it on your first command in that session (e.g. the `open`).

## How it works

```text
agent / human  →  br CLI (Zig)  →  JSONL over a Unix socket  →  Bun worker  →  Bun.WebView
```

`br` starts a persistent Bun worker automatically and talks to it over a Unix socket under `$XDG_RUNTIME_DIR/br/`. See [`.github/ARCHITECTURE.md`](.github/ARCHITECTURE.md) and [`.github/AGENTS.md`](.github/AGENTS.md) for the details.

<details>
<summary><b>Exit codes</b></summary>

| Code | Meaning | | Code | Meaning |
| --- | --- | --- | --- | --- |
| `0` | success | | `13` | stale ref |
| `2` | invalid arguments | | `14` | timeout |
| `10` | browser unavailable | | `15` | evaluation failed |
| `11` | navigation failed | | `16` | protocol error |
| `12` | element not found | | `70` | internal error |

</details>

## Status

Experimental and early, but usable for local work. The browser backend targets Bun's experimental `Bun.WebView` API, so behavior can shift as Bun evolves. `br live` is a human debugging mode, not agent context.

## Development

```bash
nix develop
zig build
zig build test
```

## License

[MIT](LICENSE)
