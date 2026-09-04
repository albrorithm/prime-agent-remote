# Code review, September 2026

A full read of the repository on the `claude/code-review-23tpqp` branch, with
the fixes that were safe to make in-branch applied, and the rest written up
here. Every finding below was verified against the code, and where a claim
could be measured it was: the LaTeX overflow, the quadratic scrubber, and the
slash-menu Enter loop were reproduced before being fixed.

The suite runs green apart from twelve tests that make a directory read-only
and expect a write to fail. They fail only as root, where `chmod` does not
bite; CI runs unprivileged and they pass there.

## What the repo is like

The code is careful. Comments explain why, often with the incident that
taught the lesson, and the security document describes what the gateway does
rather than what it hopes. The trust boundary is real: the browser never gets a
path, a raw daemon command, or a credential hash. The weak spots are of two
kinds. A handful of invariants drifted from what the docs say. And the
production backend does not use the incremental half of its own protocol, so
the client's replay and delta machinery serve the demo alone while phones
receive whole transcripts on every token.

## Fixed on this branch

Ordered by what it would have cost a user.

### Availability and correctness

- **`sanitizeTranscriptPreview` could hold the event loop for seconds**
  (`src/server/transcript-previews.ts`). The e-mail pattern is quadratic in a
  word run and nothing bounded its input; a 300 KB line of model output took
  37 s. Input is now capped before any pattern runs, and `thinkingRecap` caps
  its block the same way. A test asserts the bound.
- **A stray `}` in math dropped the rest of the expression, and a few thousand
  unclosed `{` overflowed the stack and blanked the whole app**
  (`src/web/latex.ts`). There is no error boundary, so a poisoned first session
  re-blanked the app on every launch. The parser now continues past a top-level
  close brace, bounds group depth at 64, and `latexToUnicode` never throws.
- **`rebuild` took the live app down for the whole build and could destroy the
  only good build** (`src/cli/index.ts`). It moved `dist/` aside while the
  gateway still served it, so every request 404ed until the build finished,
  and a Ctrl-C mid-build left the good build under the backup name, which the
  next run deleted first. The gateway is now stopped before the swap and an
  orphaned backup is restored before anything is removed. `rebuild` and
  `devices --revoke` share one `restart` that reports a throwing `start`
  instead of letting it escape past the message.
- **A failed `start` left a Tailscale Serve mapping pointing at a dead port,
  and `stop` could never remove it** (`src/cli/index.ts`). The next `start`
  found the mapping "ours" and never recorded it as managed. A failed
  background start now unpublishes what it published. Spawn errors are
  handled on both start paths instead of crashing the CLI.
- **A session the person stopped or aborted was announced as "Finished and
  waiting on you"** (`src/server/gateway.ts`). The abort and stop routes now
  disarm the turn-end notifier, with a gateway test.
- **Enter could never submit a slash command that takes an option**
  (`src/web/hooks/useSlashCommandMenu.ts`). `/model openai/other` re-selected
  itself on every Enter; the only way out was the Send button. The exact-match
  rule now compares the draft to the suggestion's completion.
- **The keyboard re-pin observer never attached when the app started with no
  session** (`src/web/hooks/useScrollFollowing.ts`). The effect was keyed on
  nothing and read a ref that was still empty. It is keyed on the selected
  agent now. In the same hook, an old image lazy-loading while the reader
  scrolled up produced a phantom "Latest (1)", and `jumpToLatest`'s smooth
  scroll was cancelled by the pin effect one commit later.
- **`/name` accepted control characters the rename route refuses**
  (`src/server/prime-backend.ts`, `demo-backend.ts`). Both now validate through
  `sessionNameSchema`.
- **Session and experimental slash commands ran outside the per-agent command
  lock** that `sendMessage` and direct commands take, so one could interleave
  with a message to the same agent. `executeSlashCommand` now takes the lock
  once and checks the revision once.
- **`--demo` minted its VAPID keypair into the real config directory**
  (`src/cli/demo-stores.ts`). The demo file list is now keyed on
  `CONFIG_FILE_VARIABLES` with `satisfies`, so a new store file is a compile
  error until it has a demo name, and the test walks the server's list.
- **`devices --revoke` reported "No device with id" over a device store it
  could not read** (`src/cli/index.ts`, `src/server/device-store.ts`). The
  device store now has the same `strict` load the push store already had, and
  the CLI uses it for both before writing anything.
- **A full disk 500ed every resume** (`src/server/device-store.ts`). `verify`
  awaited the `lastSeenAt` write and the rejection reached the route. The
  write is now best-effort; `issue` keeps its rejection, because a credential
  not on disk must not be handed out.
- **Shutdown backstops were armed after the await they guard**
  (`src/server/index.ts`). A wedged daemon socket held `gateway.shutdown()`
  open and SIGTERM did nothing. The timers are armed first and `server.close`
  runs in a `finally`.
- **`tailscale serve status --json` on a never-configured node prints `null`**,
  which was read as "unknown", so auto-publish never fired on the machine it
  exists for (`src/cli/tailscale.ts`). `null` is now "free". Medium
  confidence: verified by reading the Tailscale CLI source, not on a node.
- **A credential containing the other quote character passed the scrubber**
  (`export PASSWORD="don't"`). The quoted rule now accepts either quote with
  the other inside.
- **A mistyped pairing token reset the whole app**, and a bad pairing link
  reset it twice (`src/web/api.ts`). `pair` now owns its 401: there is no
  session to expire.
- **An attention answer that timed out and was tapped again was a new
  request**, which the gateway refused as already resolved. `respond` now
  keeps its request id per attention and option until the answer lands.
- **A 2xx with a non-JSON body surfaced a raw `SyntaxError` to the user.** It
  is now a 502 `ApiError` like every other bad body.
- **StrictMode wrote default settings over storage on every open**
  (`src/web/settings.tsx`). A first-run flag did not survive setup, cleanup,
  setup; a dirty flag set by the mutators does.
- **`atomic-file` did not sync before renaming**, so the "a crash leaves the
  previous file" guarantee held for a process crash but not a power loss. The
  temp file is synced now.

### Documentation that did not match the code

- `docs/security.md` claimed resume guesses were "capped as strictly as
  guessing the token". They are charged to the address's pairing budget but
  the resume route never refuses on it, because the credential is verified
  before the charge and refusing earlier would lock legitimate devices behind
  a shared reverse-proxy address out with the guesser. The document now says
  that, and says what actually makes guessing hopeless: the 256-bit secret.
- `docs/security.md` said a push record "is never removed for being old". The
  store evicted the oldest at 20. The bound is now 32, one per device the
  device store can hold, and the sentence says so.
- The retry schedule in `docs/security.md` only runs while the store is
  quiet; a caller's own write is the retry in between. Said now.
- README: `token --qr` was missing, `rebuild` was listed as if it worked on a
  published install, and demo mode's separated files were listed short.

### Simplifications

- `MutationCache.pendingTtlMs` was a constructor parameter that nothing read;
  a test existed to assert it had no effect. Removed with the test.
- `exposure.ts` carried an HTTPS LAN branch with no way to reach it (no flag
  set `tlsConfigured`) and a test for it. Removed.
- A `RangeError` was the sentinel for "path not absolute" between
  `directories.ts` and the gateway, so any other `RangeError` would have been
  reported as a bad path. It is a `DirectoryPathError` now.
- CI built three times and typechecked four (`prepare` on `npm ci`, then
  `typecheck`, then `smoke`'s own build). It now installs with
  `--ignore-scripts`, builds once, and runs the smoke test against that
  build. Added `permissions: contents: read` and a timeout.
- The coverage block in `vitest.config.ts` documented itself as never
  running. Removed. `MAX_DEVICE_LABEL_CHARS` was exported and unused; the
  "longest first" comment described an order that is not longest-first.
  `PushSubscriptionBody` restated a schema. A `cd` strip in the bash
  summariser could never match after the split that preceded it.

## Not fixed, and recommended

Ranked. The first three are one design decision seen from three sides.

### 1. The Prime backend streams whole snapshots on every daemon event

`applyPrimeSnapshot` re-projects the entire transcript (up to 1,000 messages,
2 MiB of text) and publishes `agent.replaced` with the whole thing on every
event, debounced at 40 ms. The hub then deep-clones that snapshot twice
(`structuredClone(event)` and `structuredClone(snapshot)`), and every
attached socket receives a frame carrying the full transcript. A long session
streaming tokens sends a phone the whole conversation many times a second.
The protocol has `agent.message_added` and `agent.message_updated`, the
client applies them, and only the demo backend ever emits them.

Recommendation: diff the previous projection against the new one in
`applyPrimeSnapshot`. When the earlier messages are unchanged by id and text
and only the tail moved, publish `message_updated` or `message_added` for the
tail; fall back to `agent.replaced` when the dashboard, attention, or an
earlier row changed. Delta events would need to carry the new revision, or
the client's revision goes stale and the next mutation costs a 409 round
trip. That is a protocol addition worth making. The single most valuable
change available to this repo.

### 2. The replay ring buffer serves nothing in production

Because every production publish is a `replaced` event, and `publish` clears
the ring on those, the ring never holds more than one event. `attach` with a
cursor gets either an empty replay or a snapshot. The ring size, byte budget,
batch threshold, `replay` frame, gap detection, and the client's `replaying`
phase are live code for the demo alone. Either finding 1 gives them a job or
they should go, and the protocol document with them.

### 3. Opening an agent fetches its transcript twice

`hydrateAgent` attaches on the socket, which synchronously yields a snapshot
frame, and then GETs the same snapshot over HTTP. The HTTP fetch exists to
raise `transcript_error` and to work when the socket is down. When the socket
is open it doubles the transfer of the largest payload the app has. Skip the
HTTP fetch when the attach delivers a snapshot within a deadline.

### 4. The composer resets on an agent change that cannot happen

`TranscriptPanel` renders `<Composer key={selectedAgent.id}>`, so the id never
changes within a mount. The reset effects and `activeAgentIdRef` guards in
`Composer.tsx`, `useOptionsMenu.ts`, `useSlashCommandMenu.ts`, and
`useImageAttachments.ts` are dead, and their tests exercise a transition the
app cannot make. About 80 lines and several refs. Not done here because the
tests would need rewriting as unmount-cleanup tests and the change spans
four modules.

### 5. Push stops working silently after a VAPID rotation

`readPushState` reports "on" for any existing subscription, `reclaim` re-sends
it every launch, and the gateway forgets a record only on 404/410; a key
mismatch is 401/403 and is swallowed. Settings says "On for this device" and
nothing arrives. Compare `subscription.options.applicationServerKey` with the
gateway's key in `readPushState`; on mismatch unsubscribe locally and report
"off". Medium confidence, and it touches a flow that needs a real device to
verify.

### 6. A notification tap while the app is open does not route

`sw.js` `openApp` only navigates when no window exists; with one it focuses
and drops `agentId`, and the app registers no `message` listener. Session B
asks a question, the person taps, and the app comes up on session A. Either
`postMessage({ agentId })` with a listener that selects it, or
`client.navigate` before `focus`. The test pins the current behaviour.

### 7. A touch that starts on the letterbox closes the image viewer

`closeFromBackdrop` runs on `pointerdown` and closes when the point is
outside the rendered image, so a pinch whose first finger lands beside a
landscape photo closes the viewer. Decide on `pointerup` without movement,
ignore non-primary pointers, and skip while a second touch is down. Needs a
phone to verify, per `CLAUDE.md`.

### 8. Accessibility

The transcript scroller is a `div` with `aria-label` and no role, so the
label is dropped, and no `tabIndex`, so a keyboard cannot scroll it. The
composer textarea carries `aria-autocomplete`, `aria-controls`, and
`aria-activedescendant` without `role="combobox"` or `aria-expanded`, and the
options trigger's `aria-controls` names an element that only exists while
the menu is open. All small; all change what is rendered, so they belong
with a look in the harness.

### 9. Foreground `start` on Ctrl-C leaves the Serve mapping

The foreground path unpublishes on the child's `exit` event, but Ctrl-C ends
the parent first. Install `SIGINT`/`SIGTERM` handlers that forward to the
child and await its exit.

### 10. Duplicate machinery

- `device-store.ts` and `push-store.ts` carry the same 25-line bounded JSON
  loader and the same dedupe helper. One `loadBoundedRecords` beside
  `PersistQueue` would leave each with a two-line `load`.
- `AgentFamilyPicker.tsx` duplicates its popover portal, positioning, and
  dismissal machinery verbatim in `AncestorMenu`, while the docstring says it
  reuses it. About 90 lines. `measurePickerMenu` also re-probes safe-area
  insets on every viewport event.
- `protocol.ts` declares nearly every type twice, as an interface and as a
  Zod schema, with nothing asserting they agree; the `notificationLabel`
  comment records the drift that caused. `ClientFrame` and
  `SlashCommandResult` already derive the type from the schema. Do that
  everywhere.
- `gateway-store.tsx` repeats the same socket teardown in
  `resetForUnauthorized`, the unmount cleanup, and `reconnect`.
- The device revoke route keeps three mechanisms for one failed push write:
  the store's background retry, a 500 asking the person to retry, and an
  in-memory set of failed ids. Thirty lines of comment defend it. Since the
  store retries and logs on exhaustion, the route could return the in-memory
  truth and let the store own durability.

### 11. Pairing at capacity silently unpairs the oldest device

`DeviceStore.issue` slices to 32. Anyone with the token can pair, so this is
not an escalation, but a legitimate phone loses its credential with no signal
anywhere. Refusing the pairing is the safer failure.

### 12. The demo backend is static where the real one moves

Answering an attention request goes idle in demo where Prime resumes the
turn, and demo never raises attention at runtime, so the arrive-while-attached
flow, the badge transition, push, and the notifier's answer-then-finish path
are unreachable in the default backend. A demo agent that asks a question a
few seconds into a streamed reply would cover most of it.

### 13. The CLI's orchestration is untested

Every pure helper in `src/cli` has a test; `start`, `stop`, `rebuild`,
`revokeDevices`, and Serve ownership have none and are not exported. That is
where four of this review's CLI bugs lived. `tailscale.ts` already injects
its runner; the same shape for spawn and signals would make these testable.

### 14. Smaller items

- `scripts/smoke.mjs` starts a second gateway on the same isolated store
  paths while the first is running, which is the concurrent-write situation
  the CLI's own comments call unsafe. Give it its own `mkdtemp`.
- `state.ts` type-checks `noServe` but not `serveManaged`.
- Flags are not validated per command; `stop --port 1` is accepted silently.
- `applyRevocation` builds its stores with an empty retry list, so a single
  failed CLI write logs "after repeated attempts".
- `push-payload.ts` sets `attentionId` "because the service worker routes on
  it"; the worker routes on `agentId` and never reads it.
- `config.ts` parses the VAPID subject twice.
- Tests that pin constants to their own literals
  (`websocket-frames.test.ts`), a "leaves no temp file" test that checks the
  file is non-empty (`pairing-token.test.ts`), and two copies of the same
  retry-timer harness (`push-store.test.ts`, `persist-queue.test.ts`).
- `index.html` uses the deprecated `apple-mobile-web-app-capable` alone.
- `extensions/webui.ts` is tab-indented in a two-space repo.

## Method

The core was read by hand: `protocol.ts`, `gateway.ts`, `auth.ts`,
`event-hub.ts`, `prime-backend.ts`, and `gateway-store.tsx`. Four parallel
reviewers covered the CLI and scripts, the server support modules, the web
components and hooks, and the web utilities, each asked to verify before
reporting. Their findings were re-checked against the source before any were
acted on; several line references were wrong and two claims were dropped as
unverifiable here.
