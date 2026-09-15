# Prime daemon client compatibility

Remote ships a generated client subset of Prime Agent at
`878410b3981f20c6d685faa210ad0e43426cf483` (protocol 7, schema 28).
It exports `DaemonClient`, `DaemonAgentConnection`, and `defaultDaemonSocketPath`.
The bundle keeps upstream's request envelopes, capability checks, structured
errors, snapshot assembly, and reconnection logic. It contains no provider SDK,
model runner, Python runtime, installer, or daemon supervisor. Only Node built-in
modules remain as runtime imports. Remote still requires Node to run its gateway.

The upstream npm release package contains the full agent and its dependencies,
rather than a separately published daemon SDK. Bundling the client entrypoints
avoids installing a second agent runtime or relying on files left by a previous
Node installation. Normal installation and builds do not download client code.

Resolution tries an explicit `PRIME_AGENT_MODULE`, the bundled SDK, then the
legacy `prime-agent` dependency and global npm package. Existing Node daemons
use the bundled SDK by default. To exercise a particular Node SDK or development
build, point `PRIME_AGENT_MODULE` at its package directory or built entrypoint.
An invalid override retains the existing fallback behavior. A native executable
cannot be imported as an SDK. Reinstall Remote if its bundled files are missing.

The SDK identifies itself as `0.9.4+878410b` to distinguish the reviewed main
commit from the v0.9.4 tag. This is not the running daemon's version. Upstream
does not supply an application build identity in its hello, so diagnostics
report the daemon version as unknown. A protocol handshake is not a version check.

## Regeneration

Download the source archive for the exact commit above and extract it into a
temporary directory. With Remote's locked development dependencies installed:

```sh
node scripts/vendor-prime-client.mjs /path/to/upstream-source --check
```

This uses esbuild 0.28.2 without executing upstream scripts. Source paths and
SHA-256 digests are recorded in `vendor/prime-daemon/provenance.json`; the check
must reproduce both the recorded inputs and the bundle byte for byte. Normal
builds ship the checked-in result. The script marks only unused `proper-lockfile`
imports as free of side effects so the unrelated lease implementations can be
removed. It fails if any non-Node dependency survives in the emitted client.
The bundle reads its adjacent package metadata to preserve upstream's Prime
configuration directory and environment variable names. Keep those files together.

For a new upstream revision, review the source/API and bundle changes, update
the script's commit/version pin and provenance together, and run the adapter,
resolver, recovery, and packaged-client checks. Do not just change the displayed
version. The upstream MIT license ships beside the bundle.

## Verification boundaries

After building, run `node scripts/smoke-prime-client.mjs /path/to/installed/remote`
against an isolated package installation. This uses the real bundled client and
backend with a fake Unix-socket daemon, covering listing, temporary recovery,
snapshot/stream registration, and reconnect. It sends no model prompts and does
not connect to the user's daemon. Gateway and browser regression tests separately
cover temporary versus terminal failure, bounded retries, and cancellation.

A real compiled-only Prime daemon still requires separate live acceptance:
list, attach, streaming, restart/update, and rollback. A fake daemon cannot prove
those runtime behaviors. Use disposable sessions for any mutation checks.
