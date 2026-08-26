# Architecture

`br` is split into a small Zig command runner and a Bun browser worker.

```text
agent or human
    |
    v
br CLI (Zig)
    |
    | JSONL over Unix socket
    v
Bun worker
    |
    v
Bun.WebView
    |
    v
browser backend
```

## Zig

Zig owns:

- CLI parsing
- session/profile validation
- daemon startup
- JSONL request construction
- exit-code mapping
- stdout/stderr discipline
- batch forwarding
- Kitty live-mode process launch for `br live`

Files:

```text
src/main.zig      process entrypoint and worker launching
src/cli.zig       command parser
src/protocol.zig  JSONL protocol writer
src/session.zig   runtime/profile paths and identifier validation
src/errors.zig    stable error codes
src/output.zig    terminal-output sanitization
src/root.zig      test/import root
```

## Bun Worker

Bun owns browser state and WebView operations.

Files:

```text
worker/main.ts      persistent Unix-socket server
worker/client.ts     small socket client used by Zig
worker/browser.ts    command handlers
worker/snapshot.ts   semantic snapshot extraction
worker/refs.ts       @ref mapping
worker/live.ts       experimental human terminal browser
worker/protocol.ts   request/response helpers
```

## Protocol

Requests are JSONL:

```json
{"version":1,"id":42,"session":"default","method":"click","params":{"target":"@7"}}
```

Responses are JSONL:

```json
{"version":1,"id":42,"ok":true,"result":{"url":"https://example.com"}}
```

Errors never expose Bun stack traces to agents:

```json
{"version":1,"id":42,"ok":false,"error":{"code":"STALE_REF","message":"Element @7 is no longer valid; run `br snap` again","ref":"@7"}}
```

## Worker Discovery

The Zig binary locates worker scripts as follows:

1. `BR_WORKER_DIR`, for packaged installs.
2. `worker/`, for repository checkouts.

The Bun executable is selected by `BR_BUN`, falling back to `bun` on `PATH`.

## Output Rules

- Human mode can emit text or Kitty graphics.
- JSON mode emits only JSON on stdout.
- Debug output belongs on stderr.
- Page-derived terminal output is sanitized unless the command explicitly emits Kitty graphics.
