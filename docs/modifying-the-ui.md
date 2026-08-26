# Changing the web UI

This is written for an agent working on this project, and for anyone doing a
quick change to their own installation.

## Know which thing you are looking at

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
prime-agent-mobile status
```

From inside a Prime Agent session, `/webui` answers the same question and
starts the gateway if it is not running.

Verifying against a port other than the one being served is the most expensive
mistake available here. It reports success while the shipped app is unchanged.
If a check needs a server, use the one that is already running. Do not start a
second one on another port.

## Making a change live

```
prime-agent-mobile rebuild
```

This rebuilds and restarts a running gateway, then names the address to check.
Both halves matter: a rebuild alone refreshes `dist/`, which a browser reload
picks up, but leaves a changed server running its old code.

If the build fails, the previous build is put back and the app keeps working.
A broken edit costs a failed command, not a broken installation.

## Undoing a change

In a git checkout, ordinary git:

```
git checkout -- src/web
prime-agent-mobile rebuild
```

In an installed copy, reinstall the package. Local edits are not preserved
across an upgrade and are not meant to be.

## What tests can and cannot tell you

`npm test` runs under jsdom, which has no layout engine: every element reports
zero pixels in every dimension. A test can confirm that a badge renders, that
it holds the right text, and that it is reachable. It cannot see that the
badge is clipping its digits.

So tests are the wrong instrument for anything with a rendered dimension, and
adding more of them does not help. Look at the change in a real browser engine
— WebKit, because this ships as an installed iOS PWA and that is the engine
that decides. Headless WebKit is still not a phone: safe-area insets are zero
and there is no device text inflation, so anything depending on those needs
real hardware.

## The screen is not the page

Every full-screen fixed layer — the shell, the drawers, the scrims, the image
viewer — is sized and placed against the **visual** viewport, not the layout
viewport, through two custom properties that `useViewportGeometry` writes on
`<html>`:

| | |
|---|---|
| `--viewport-top` | where the visible part of the page starts |
| `--viewport-height` | how much of it can be seen |

`position: fixed` resolves against the layout viewport, and on iOS WebKit the
two are not the same rectangle. Just after an installed launch the layout
viewport is sometimes reported taller than the screen, and a layer at
`inset: 0` then hangs off the display — which is why the top bar or the
composer could be missing on first open. And iOS uses
`interactive-widget: resizes-visual`, so the layout viewport does **not**
shrink when the keyboard opens: WebKit scrolls the whole page up to lift the
focused field clear of it, carrying the header and, on iPad, the drawers with
it.

Sizing to the visible rectangle answers both. The shell ends exactly where the
keyboard begins, so the composer comes to rest on top of it and nothing else
has to move; the transcript is the shell's one flexible row, so it is what
gives up the height, and it re-pins to its latest message when it does.

The rules that follow from this:

- A new full-screen fixed layer joins the `--viewport-top` / `--viewport-height`
  rule in `styles.css` rather than using `inset: 0`. A fixed pill positioned
  from the top edge adds `var(--viewport-top, 0px)` to its offset.
- Every use site carries its own fallback, so a tree where the hook has not run
  keeps its previous layout. Do not give these properties a `:root` default.
- Anything that must fit on screen measures against `--viewport-height`, not
  `dvh`. With the keyboard up, `dvh` is still the whole screen.
- `env(keyboard-inset-*)` and the VirtualKeyboard API are Chromium-only, and no
  shipping Safari announces `interactive-widget`. `window.visualViewport` is
  the only signal available here.

`.ui-harness/scripts/keyboard-probe.mjs` opens a scripted keyboard against a
real shell in WebKit and Chromium and checks what moved. Run it after touching
any of this.

## House rules that apply to any change here

- Tests live beside the module they cover, as `*.test.ts` or `*.test.tsx`.
- `src/protocol.ts` is the shared wire contract and the only module both
  tsconfigs compile. Logic the server and the web app must agree on goes there.
- The gateway is the sole owner of daemon clients. A change that widens what
  the browser can reach updates `docs/security.md` in the same commit.
