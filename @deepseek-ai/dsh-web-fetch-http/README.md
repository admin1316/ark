# @deepseek-ai/dsh-web-fetch-http

English | [中文](README.zh.md)

An anonymous public HTTP(S) `WebFetchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It retrieves a concrete URL and returns a status code plus bounded decoded content.

This is an **implementation** package: it registers a provider into `ctx.web`, it does not own the key and it does not register a model-facing tool. It is a function/namespace plugin (`inject: ['web']`).

## Responsibility split

The provider owns **safe resource retrieval**: URL validation, HTTP transport, redirect policy, a resource-backstop timeout, abort propagation, byte caps, charset decoding, content-type classification, and binary rejection. `@deepseek-ai/dsh-tool-web` owns **presentation** (HTML→markdown, truncation formatting). A non-2xx HTTP response is a *result* (status code + decoded body), not an error; `WebError` is reserved for failures to safely retrieve or represent the resource.

The provider's `timeoutMs` is a resource backstop for direct `ctx.web.fetch()` callers and misconfigured deployments, not the model-facing tool-call budget. [`dsh-tool-call-timeout-policy`](../../guard/timeout-policy/README.md) owns the `web_fetch` tool-call budget by arming `exec.signal`.

A shipping web-tool deployment sets the provider backstop above the tool budget, so model calls normally return `TOOL_TIMEOUT`. If the outer deadline reaches the provider first, the provider reports `WEB_ABORTED` and the outer policy replaces it with `TOOL_TIMEOUT`. `WEB_FETCH_TIMEOUT` therefore identifies a direct service caller whose provider budget elapsed.

## Transport hygiene

- Accepts only `http:` and `https:` URLs; rejects credentials in URLs (`WEB_BLOCKED_URL`) and over-long/malformed URLs (`WEB_INVALID_URL`).
- Resolves every initial and redirected hostname before opening a connection, rejects the complete answer set when any IPv4, IPv6, IPv4-mapped, or detected NAT64 destination is not public global unicast, and rejects empty or malformed DNS answers.
- Pins the validated address set into a request-local Undici dispatcher while retaining the URL hostname for HTTP `Host` and TLS SNI, so the connection cannot perform a second DNS lookup and rebind to a private destination.
- Enforces a max URL length, response byte cap (`WEB_FETCH_TOO_LARGE`), decoded body character cap, timeout (`WEB_FETCH_TIMEOUT`), and redirect hop cap.
- Propagates the caller's abort signal (`WEB_ABORTED`) into the network request and the streaming read.
- Follows only **same-origin** redirects and repeats public-address validation and pinning before every hop; a cross-origin redirect fails with `WEB_REDIRECT_BLOCKED`, requiring a fresh tool call (the model of Claude Code's WebFetch).
- Sends an explicit product `User-Agent`, never a browser disguise.
- Rejects unsupported (e.g. binary) content types with `WEB_UNSUPPORTED_CONTENT_TYPE`.

## Config

| Key | Default | Meaning |
|---|---|---|
| `maxUrlLength` | `2048` | Maximum accepted request URL length. |
| `maxResponseBytes` | `5_000_000` | Maximum response body size in bytes. |
| `maxBodyChars` | `100_000` | Maximum decoded body length in characters. |
| `timeoutMs` | `30_000` | Fetch timeout within Node's timer range — a resource backstop for direct `ctx.web.fetch()` callers, not the model-facing tool-call budget (that is `dsh-tool-call-timeout-policy`). |
| `maxRedirects` | `5` | Maximum same-origin redirect hops (`0` follows none). |
| `userAgent` | `deepseek-harness/…` | `User-Agent` header. |

The numeric limits are validated at plugin construction: every cap except `maxRedirects` must be a positive finite number, and `maxRedirects` must be a non-negative integer. An invalid value throws rather than silently constructing a provider with nonsensical limits.

## Model Experience

Indirectly, through [`dsh-tool-web`](../tool-web/README.md), which places this provider's `maxBodyChars`-bounded decoded text or markdown-shaped HTML under its fetch-result wrapper and retains provider failures while redirects, headers, and transport mechanics remain hidden.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Public network only** — there is no private-network allowlist or per-request bypass. A mixed public/private answer is rejected as a whole, and failure to complete conservative IPv6/NAT64 validation fails the request rather than opening an unpinned connection.
- **Only textual content decodes** — html/xhtml and `text/*`-plus-JSON/XML families; a missing `Content-Type` or any binary type throws `WEB_UNSUPPORTED_CONTENT_TYPE`, and text-extractable PDF decoding is named deferred work.
- **Charset comes only from the `Content-Type` header** (UTF-8 default) — an HTML `<meta charset>` declaration is ignored, and a declared-but-unrecognized charset label throws rather than falling back.
