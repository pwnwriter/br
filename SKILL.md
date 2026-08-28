---
name: web-login-and-screenshot
description: Log into a website and capture a screenshot of a page using the `br` browser CLI. Use this when a user asks an agent to sign in to a site from the terminal and grab a picture of a page (a dashboard, a listing, a result), on accounts the user is authorized to access.
---

# Skill: log in to a website and screenshot it with `br`

You can drive a real browser from the shell with **`br`**. This skill logs in to
a page with a username + password and captures a screenshot. It works the same
whichever agent you are (Codex, Claude, etc.): you just run shell commands.

## The one rule that prevents most failures

**`@refs` come from `br snap`.** A `@ref` (like `@4`) is a handle to an element
on the **current** page, and it only exists after you snapshot. So:

- Snapshot **before** you act. Read the output, pick the ref you need, then act.
- After any navigation or submit, **snapshot again**; old refs are stale.
- If a command returns `STALE_REF @n`, the page changed: run `br snap` again and
  use the **new** ref. Never guess or reuse a ref you have not just seen.

## The model

```
br open <url>  →  br snap  →  read @refs  →  br fill / click / press  →  br screenshot
```

`br` prints a compact, semantic list of the interactive elements. You choose
refs from that list. There is no DOM to parse.

## Procedure: log in and screenshot

Use a `--profile` so the session (cookies) persists between commands and runs.

```bash
P=login                                  # any profile name; keeps you signed in
br --profile $P open <login-url>
br --profile $P wait 3000                # let the page settle
br --profile $P snap --compact           # READ this output before continuing
```

The snapshot looks like:

```
@1 textbox  Email          type=email
@2 textbox  Password        type=password
@3 button   Sign in
```

Pick the refs from what you actually see, then:

```bash
br --profile $P fill @1 "<username-or-email>"
br --profile $P fill @2 "<password>"
br --profile $P click @3                 # or: br --profile $P press Enter
br --profile $P wait 5000                # let the login complete / redirect
```

Then navigate to the page you want and capture it:

```bash
br --profile $P open <target-url>        # e.g. the dashboard or a listing
br --profile $P wait 4000
br --profile $P screenshot out.png       # saves a PNG you can open/attach
```

`br screenshot <path>` writes a real PNG. Prefer it over `br view` when you are
an agent: `br view` emits inline terminal graphics that an agent harness cannot
read, whereas a PNG file works everywhere.

### Identifying fields (how to read the snapshot)

- The **password** field is the element whose `type=password`.
- The **email/username** field is a `textbox` whose `type` is `email`/`text`, or
  whose name mentions email / user / login / account.
- The **submit** button is a `button` whose name matches sign in / log in /
  continue / connect / next. If there is no obvious button, `press Enter` while a
  field is focused usually submits.

If you have `jq`, you can auto-detect from `--json snap` instead of reading:

```bash
snap="$(br --profile $P --json snap)"
email=$(jq -r '[.elements[]|select(.role=="textbox" and ((.attrs.type=="email") or (.attrs.type=="text") or (.name|test("e-?mail|user|login|account";"i"))))][0].ref // empty' <<<"$snap")
pass=$( jq -r '[.elements[]|select(.attrs.type=="password")][0].ref // empty' <<<"$snap")
submit=$(jq -r '[.elements[]|select(.role=="button" and (.name|test("log ?in|sign ?in|continue|connect|next";"i")))][0].ref // empty' <<<"$snap")
```

## Credentials

- **Get credentials from the user**, or from an environment variable the user
  names (e.g. `"$SITE_PASS"`). Never invent them, never hardcode a literal, and
  never print the password back to the user.
- Only log in to accounts the user is authorized to access.
- The password is passed to `br` as a process argument, so treat the machine as
  trusted.

## Gotchas

- **Already logged in.** With a persistent `--profile`, the login URL often
  redirects straight to the app, so there is no password field in the snapshot.
  That is success: skip the login steps and go straight to `open` + `screenshot`.
- **CAPTCHA / 2FA.** `br` cannot solve these. If login stalls, tell the user to
  finish in the WebView window, or run `br --profile $P live <login-url>` so they
  can log in by hand once. The profile persists afterward; then re-run from the
  `open <target-url>` + `screenshot` steps.
- **Multi-step logins** (email on page 1, password on page 2): after submitting
  the first step, **snapshot again** and fill the password ref from the *new*
  snapshot.
- **Bare hosts are fine.** `br open news.ycombinator.com` works; `br` adds
  `https://`.
- **Branch on results** with `--json` (e.g. check `"ok":true`) instead of parsing
  human text. Do not parse `view` / `live` graphics output.

## Environment

- `br` needs **Bun** with `Bun.WebView`. Release tarballs bundle a matching Bun,
  so `br` from a release works with no extra install. Otherwise Bun must be on
  `PATH` (or `$BR_BUN` set).
- If `br` is not on `PATH`, use the path the user gives you (e.g.
  `./zig-out/bin/br`, or `./br-<version>-<target>/br` from a release). Substitute
  that path everywhere `br` appears above.

## Minimal end-to-end example

```bash
P=demo
br --profile $P open https://example.com/login
br --profile $P wait 3000
br --profile $P snap --compact           # read refs
br --profile $P fill @1 "me@example.com"
br --profile $P fill @2 "$SITE_PASS"
br --profile $P click @3                 # or press Enter
br --profile $P wait 5000
br --profile $P open https://example.com/dashboard
br --profile $P wait 4000
br --profile $P screenshot dashboard.png
```
