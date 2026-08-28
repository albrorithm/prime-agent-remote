# Changing the web UI

This is written for an agent working on this project, and for anyone doing a
quick change to their own installation.

## Know which server you are looking at

There are two servers and they do not behave alike.

| | Port | What it is |
|---|---|---|
| Vite dev server | 5173 | Fast reload, convenient to edit against |
| The gateway | 8787 | What users install |

The service worker registers in production builds only, so anything touching
installability, offline behaviour, notifications, or the app badge cannot be
observed on 5173 at all.

Ask the running system where it is rather than assuming:

```
prime-agent-remote status
```

From inside a Prime Agent session, `/webui` answers the same question and
starts the gateway if it is not running.

The most expensive mistake here is verifying against a port other than the one
being served, because it reports success while the shipped app is unchanged.
If a check needs a server, use the one that is already running. Do not start a
second one on another port.

## Making a change live

```
prime-agent-remote rebuild
```

This rebuilds and restarts a running gateway, then prints the address to
check. Both steps matter: a rebuild alone refreshes `dist/`, which a browser
reload picks up, but leaves a changed server running its old code.

If the build fails, the previous build is restored and the app keeps working.
A broken edit costs a failed command, not a broken installation.

## Undoing a change

In a git checkout, ordinary git:

```
git checkout -- src/web
prime-agent-remote rebuild
```

In an installed copy, reinstall the package. Local edits are not preserved
across an upgrade and are not meant to be.

## What tests can and cannot tell you

`npm test` runs under jsdom, which has no layout engine: every element reports
zero pixels in every dimension. A test can confirm that a badge renders, that
it holds the right text, and that it is reachable. It cannot see that the
badge is clipping its digits.

Tests are therefore the wrong instrument for anything with a rendered
dimension, and adding more of them does not help. Look at the change in a real
browser engine, meaning WebKit, because this ships as an installed iOS PWA and
that is the engine that decides. Headless WebKit is still not a phone: safe-area
insets are zero and there is no device text inflation, so anything depending
on those needs real hardware.

## Viewport geometry

Every full-screen layer (the shell, the drawers, the scrims, the image viewer)
is sized and placed against the **visual** viewport, not the layout viewport,
through two custom properties that `useViewportGeometry` writes on `<html>`:

| | |
|---|---|
| `--viewport-top` | where the visible part of the page starts |
| `--viewport-height` | how much of it can be seen |

This is a **launch** fix and only a launch fix. Just after an installed launch
the layout viewport is sometimes reported taller than the screen, and a layer
at `inset: 0` then hangs off the display. That is why the top bar or the
composer could be missing on first open.

## Keyboard handling

When the keyboard opens, `useViewportGeometry` stops publishing entirely (no
height, no offset, no scroll correction) until it closes again.

iOS does not shrink the layout viewport for a keyboard. It scrolls the page to
lift the focused field clear, and that is legitimate platform behaviour, not a
bug to work around. Earlier versions of this app fought that scroll
in three ways: resizing the shell to the visible rectangle, compensating for
`visualViewport.offsetTop`, and clamping `scrollY` back to zero inside the
scroll event. All three caused the reported bug (the whole app lurching as
the keyboard arrives and snapping back), because the app moved where iOS put
it and was then yanked back: two motions where the platform made one. Traced
on an iPhone, `window.scrollY` reached 465 for a single frame and was back to
zero four milliseconds later because this app put it there.

So the page scrolls, the header scrolls away with it, and it stays gone until
the keyboard does. chatgpt.com behaves the same way on the same phone, and has
no jump to fix. `body` and `.app-shell` are `position: absolute` so they
travel with that scroll; iOS also suspends `position: fixed` while a keyboard
is up, so fixed would fail twice over.

**Do not make the shell hold still while the keyboard opens. That is the bug,
and it has been tried.**

### Releasing the hands-off state

Staying hands-off is only half the rule; the hook also needs a reliable way
back. The first version decided the question with `focusedEditable() ||
(trackingKeyboard && keyboard > 0)`, which has no exit while a field keeps
focus — and iOS does not reliably blur when its keyboard goes. Tapping Done,
or swiping the keyboard away, leaves the textarea focused with nothing on
screen.

The hook then stayed hands-off for the rest of the session, and three separate
complaints came out of that one latch:

- the page stayed where iOS scrolled it, so the header was gone and stayed
  gone — and the document is `overflow: hidden` at the top level, so a reader
  cannot scroll it back;
- `--viewport-height` was never re-published, so the shell kept a
  keyboard-shrunk height into the next keyboard, and the composer sat at the
  bottom of a box that ended well above the keyboard with black below it;
- `--keyboard-height` stayed published, so the composer kept its
  home-indicator inset drained with no keyboard covering the strip.

The release condition is the visual viewport returning to its full height:
that means there is no keyboard, whatever has focus. It waits
`KEYBOARD_GONE_MS` first, because a full-height reading *during* the animation
is one frame between two others, not an ending, and believing it would put the
scroll clamp back.

Restoring the scroll once the keyboard is gone is not that clamp. The clamp
ran inside the scroll event, mid-animation, against a scroll iOS was still
making. Restoring runs a quarter second after the keyboard has left, when
nothing is competing for the scroll position.

The rules that follow from this:

- A new full-screen fixed layer joins the `--viewport-top` /
  `--viewport-height` rule in `styles.css` rather than using `inset: 0`. A
  fixed pill positioned from the top edge adds `var(--viewport-top, 0px)` to
  its offset.
- Every use site carries its own fallback, so a tree where the hook has not
  run keeps its previous layout. Do not give these properties a `:root`
  default.
- Anything that must fit on screen at launch measures against
  `--viewport-height`, not `dvh`. With the keyboard up neither is the visible
  area, and neither should be — see above.
- `env(keyboard-inset-*)` and the VirtualKeyboard API are Chromium-only, and
  no shipping Safari announces `interactive-widget`. `window.visualViewport`
  is the only signal available here.

`.ui-harness/scripts/keyboard-probe.mjs` opens a scripted keyboard against a
real shell in WebKit and Chromium and checks what moved. Run it after touching
any of this — but know its limit: it changes the numbers a scripted viewport
reports and cannot scroll the page the way iOS does. It can prove the shell is
left alone; it cannot tell you where the composer ends up. That answer needs a
real device, and six rounds of this bug were spent learning it.

For the on-device answer there is `src/web/viewport-trace.ts`, which is inert
unless the URL carries `?vptrace=1`. It prints the numbers that tell the two
shapes of this bug apart on a phone: `shellH` against `docH` says whether the
shell is short or merely scrolled, and `GAP` measures how far the composer is
from the bottom of the visible viewport — zero is hugging. It samples on a
timer and never on `requestAnimationFrame`, because iOS starves rAF for ~85ms
across a keyboard transition, and an earlier version of this panel reported
"nothing moved" when the truth was "we never looked".

## House rules that apply to any change here

- Tests live beside the module they cover, as `*.test.ts` or `*.test.tsx`.
- `src/protocol.ts` is the shared wire contract and the only module both
  tsconfigs compile. Logic the server and the web app must agree on goes
  there.
- The gateway is the sole owner of daemon clients. A change that widens what
  the browser can reach updates `docs/security.md` in the same commit.
