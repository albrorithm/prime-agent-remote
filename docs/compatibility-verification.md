# Compatibility patch verification

This patch uses a pinned upstream client subset rather than installing the
full agent as a dependency. See [client compatibility](prime-client.md) and
[the review baseline](review-baseline.json).

Release candidate 0.1.3 was checked on macOS arm64 on 2026-09-14, using
Node 22.23.2 and Node 26.7.0:

- 439 focused tests passed on each Node version across the resolver, adapter,
  gateway, browser provider/reducer, API, recovery scheduler, diagnostics,
  command catalog, shared protocol, CLI, and service-worker build suites.
  The CLI and settings suites passed again after the release version change.
- `npm run build` passed on both Node versions, including all three TypeScript
  checks. The generated web, server, and vendored-client files matched byte for
  byte between runtimes before the version change. The final candidate was
  rebuilt on Node 22. Vite retains its existing large-chunk warning.
- The demo gateway smoke check passed. The real bundled SDK also passed
  list, structured recovery, snapshot, streaming, and reconnect checks against
  a disposable Unix-socket daemon, with no model prompts.
- An `npm pack --ignore-scripts` archive installed into a separate temporary
  prefix with lifecycle scripts disabled. Its resolver selected the bundled
  SDK without a legacy `prime-agent` dependency; the same fake-daemon smoke
  exercised the installed backend.
- `node scripts/vendor-prime-client.mjs /path/to/upstream-source --check`
  reproduced the committed client and provenance exactly.
- Earlier headless WebKit verification rendered the diagnostics at 320- and 390-pixel viewport
  widths with enlarged text. The inspected text wrapped without horizontal
  clipping. This is browser evidence, not physical-device acceptance.

Recovery tests cover cold attachment, HTTP 503 identity, success after backoff,
exhausted retry budgets, explicit detach and shutdown, manual reattachment,
selection retention, cancellation after a full WebSocket snapshot, and shared
HTTP reads preserving their original freshness baseline. Prompts and command
mutations are not automatically replayed. Autonomous budget arguments arrive
unchanged at the adapter.

The installed package also passed an isolated native-daemon check against
`v0.9.4-beta.832.1.dca77ec` on macOS arm64. The downloaded archive matched its
published SHA-256 digest, macOS signature verification passed, and the executable
reported the expected version. Remote used its bundled SDK for catalog listing,
disposable session creation, snapshot attachment, rename events, and restoration
after a graceful daemon shutdown and restart. A local fixture provider supplied
an actual streamed reply through the native daemon; Remote received it in the
transcript. No external model account or credentials were used. Temporary daemons
were stopped after the checks.

The client remains pinned to `878410b`; testing against the newer native beta did
not update the bundled source. Native upgrade and rollback, Linux CI, and physical
phone acceptance remain separate checks. Nothing was published, and the operator's
existing daemon and sessions were not changed.

The package version is now 0.1.3 because 0.1.2 was already published to npm.
