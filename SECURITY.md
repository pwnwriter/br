# Security

Web pages are untrusted input.

Please do not report security issues through public issues if they involve code execution, terminal escape injection, profile/session data exposure, or filesystem access.

Current hardening goals:

- validate session/profile names
- avoid shell execution from page content
- sanitize human-readable terminal output
- keep JSON mode parseable and stack-trace free
- limit protocol message sizes
- avoid storing secrets in logs

This project is experimental and not yet audited.
