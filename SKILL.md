---
name: browser-automation-with-br
description: Drive a real web browser from the shell with the `br` CLI. Use whenever a task needs a live browser from the terminal: open pages, read a compact semantic snapshot, click/fill/type, extract text or attributes, run JS in the page, wait for elements, log in, scrape a listing, or capture a screenshot. Works for any agent (Codex, Claude, etc.) and any site the user is authorized to use.
---

# Skill: browser automation with `br`

`br` turns a web page into a compact, semantic snapshot with stable `@refs`,
then lets you act on those refs. No DOM dumps, no Playwright. You (the agent)
run shell commands and read plain output.

```
br open <url>  →  br snap  →  read @refs  →  act (click/fill/type/…)  →  read/extract/capture
```

## The one rule that prevents most failures

**`@refs` come from `br snap`.** A `@ref` such as `@4` is a handle to an element
on the **current** page; it exists only after you snapshot.

- Snapshot **before** you act. Read the list, choose the ref, then act.
- After any navigation, submit, or big DOM change, **snapshot again**. Old refs
  go stale.
- If a command returns `STALE_REF @n`, the page changed: run `br snap` again and
  use the **new** ref. Never guess a ref or reuse one you have not just seen.

You can also target elements by **CSS selector** instead of a ref (e.g.
`br click "button.submit"`), but refs from a fresh snapshot are the reliable
default.

## Command reference

Global flags go before the command: `br [--json] [--session <name>] [--profile <name>] [--backend chrome|webkit] <command>`.

**Navigate**
```bash
br open <url>            # go to a page (bare hosts ok: br open news.ycombinator.com)
br back | br forward | br reload
br url                   # current URL
br title                # page title
br wait <ms>            # wait N milliseconds
br wait "<css>"        # wait until a CSS selector appears (up to a timeout)
```

**Inspect (get refs)**
```bash
br snap                 # semantic list of interactive elements + their @refs
br snap --compact       # tighter output; use this first
br find "<text>"       # find elements by visible text among the current refs
br get <ref|css>        # details for one element (role, name, attrs)
```

**Act**
```bash
br click <ref|css>
br fill  <ref|css> "<text>"     # focus, clear, then type into a field
br type  "<text>"               # type into whatever is focused
br press <key>                  # e.g. Enter, Tab, Escape, ArrowDown
br hover <ref|css>
br scroll <amount>              # pixels; positive = down, negative = up
br scroll-to <ref|css>          # scroll an element into view
```

**Read / extract**
```bash
br text [ref|css]       # text content of an element, or the whole page
br html [ref|css]       # outerHTML of an element, or the page
br attr  <ref|css> <name>   # one attribute value (href, src, data-*, …)
br value <ref|css>          # a form field's current value
br eval "<javascript>"      # run JS in the page; prints the result
br cookies              # dump cookies
br console              # surface client-side console messages / JS errors
```

**Capture**
```bash
br screenshot [path]                     # save a PNG (default br-screenshot.png)
br screenshot out.jpg --format jpeg --quality 70
br view                                   # inline render via Kitty graphics
br live [url]                             # interactive terminal browser (humans)
```

Agents: prefer `br screenshot <path>` for a visual result. `br view` / `br live`
emit terminal graphics that an agent harness cannot read; do not parse them.

In `br live`, press `a` to AI-answer the current page: multiple choice AND free
text. br collects the clickable options (`@refs`) and the writable fields
(`#refs`), hands them plus the page prose to a solver command, then clicks the
right options and writes the essay/short answers it returns. The solver is
`$BR_SOLVER` (default `claude -p`); it reads the page on stdin and returns a JSON
plan `{"clicks":["@2"],"fills":[{"ref":"#0","text":"..."}]}`. `BR_SOLVER_TIMEOUT`
(seconds, default 120) caps how long it may run.

**Viewport / admin**
```bash
br resize <width> <height>
br close                 # close the current page
br session list | br session close <name> | br session close-all
br daemon status | br daemon stop
```

**Advanced**
```bash
br eval "document.cookie"
br --backend chrome cdp <Method> [jsonParams]   # Chrome DevTools Protocol (Chromium only)
```

## Programmatic branching: `--json`

Add `--json` to any command to get machine-readable output, then branch on it
instead of parsing human text.

```bash
if br --json open "$url" | grep -q '"ok":true'; then echo loaded; fi
br --json snap            # {"ok":true,"command":"snapshot","elements":[{"ref":"@2","role":"textbox","name":"Email","attrs":{"type":"email"}}, …]}
```

Exit codes let you branch without parsing at all:
`0` success · `2` invalid args · `10` browser unavailable · `11` navigation failed ·
`12` element not found · `13` stale ref · `14` timeout · `15` eval failed ·
`16` protocol error · `70` internal error.

## Batch mode (multi-step, one shot)

For a sequence, `batch` takes one JSON object per line and returns one per line.
It never runs shell commands, so it is safe and fast.

```bash
br batch <<'JSONL'
{"command":"open","url":"https://example.com/login"}
{"command":"snapshot","compact":true}
{"command":"fill","target":"@1","text":"me@example.com"}
{"command":"fill","target":"@2","text":"SECRET"}
{"command":"click","target":"@3"}
{"command":"snapshot","compact":true}
JSONL
```

Note: refs inside a batch must match the page state at that point. If a step
navigates, snapshot again in a later line rather than reusing an old ref.

## Sessions & profiles

- `--session <name>` runs an isolated browser context (separate tabs/state). Use
  different sessions to keep parallel tasks from colliding.
- `--profile <name>` **persists** cookies/localStorage to disk, so you stay
  logged in across runs. Reuse the same profile to resume a session; use a new
  profile name (or `session close`) for a clean slate.

## Backends

- Default backend is **WebKit** (`--backend webkit`): fast, no extra setup.
- Use **Chromium** (`--backend chrome`) when you need `cdp` (Chrome DevTools
  Protocol); WebKit has no CDP.

## Recipes

**Read a page / answer a question about it**
```bash
br open https://news.ycombinator.com
br text                      # whole-page text, or:
br find "comments"          # locate a control, then br get / br attr it
br screenshot page.png
```

**Fill and submit a form**
```bash
br open <form-url>; br wait 2000
br snap --compact            # read the field refs
br fill @1 "value"; br fill @2 "value"
br click @3                  # or: br press Enter
br snap --compact            # confirm where you landed
```

**Log in, then capture a page** (accounts the user authorized)
```bash
P=login
br --profile $P open <login-url>; br --profile $P wait 3000
br --profile $P snap --compact          # find email / password / submit refs
br --profile $P fill @1 "<user>"        # password field is the one with type=password
br --profile $P fill @2 "$SITE_PASS"    # from an env var; never hardcode/print it
br --profile $P click @3                # or press Enter
br --profile $P wait 5000
br --profile $P open <target-url>       # dashboard / listing / result
br --profile $P wait 4000
br --profile $P screenshot out.png
```

**Extract structured data (scrape a listing)**
```bash
br open <list-url>; br wait 2500
br eval '[...document.querySelectorAll(".item")].map(e => ({
  title: e.querySelector("h2")?.innerText,
  href:  e.querySelector("a")?.href
}))'                          # prints JSON you can parse
```

**Recon / inspect client-side state** (authorized targets only)
```bash
br --profile t open <url>
br snap
br eval 'document.cookie'
br eval '[...document.querySelectorAll("input[type=hidden]")].map(i => [i.name, i.value])'
br attr @5 href
br cookies
br console                    # surface JS errors
br screenshot finding.png
```

## Credentials & safety

- Get credentials from the user or from an env var the user names (e.g.
  `"$SITE_PASS"`). Never invent them, never hardcode a literal, never print the
  password back.
- Only operate on sites/accounts the user is authorized to use.
- The password is passed to `br` as a process argument, so treat the machine as
  trusted.

## Gotchas

- **Already logged in.** With a persistent `--profile`, a login URL often
  redirects past the form, so there is no password field. That is success: skip
  login and go straight to `open` + `screenshot`.
- **CAPTCHA / 2FA.** `br` cannot solve these. If login stalls, ask the user to
  finish in the WebView window, or run `br --profile $P live <url>` so they log in
  by hand once; the profile persists, then continue.
- **Multi-step logins** (email then password on separate pages): snapshot again
  after the first submit and use the new refs.
- **Waiting.** After `open` or a click that loads content, `br wait "<css>"` or a
  short `br wait <ms>` before snapshotting avoids acting on a half-rendered page.
- **Do not parse** `view` / `live` graphics output. Use `screenshot`, `text`,
  `html`, `attr`, `value`, `eval`, or `--json` to read a page.

## Environment

- `br` needs **Bun** with `Bun.WebView`. Release tarballs bundle a matching Bun,
  so `br` from a release works with nothing else to install; otherwise Bun must
  be on `PATH` (or `$BR_BUN` set).
- If `br` is not on `PATH`, use the path the user gives you (e.g.
  `./zig-out/bin/br`, or `./br-<version>-<target>/br` from a release) everywhere
  `br` appears above.
