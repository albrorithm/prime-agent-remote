# Contributing

Pull requests are welcome. This repository is under the MIT license.

## House rules

- Keep tests colocated with the module they cover: add `*.test.ts` or `*.test.tsx` beside the module, not in a separate tests directory.
- Treat `src/protocol.ts` as the shared wire contract between the server and the web app. Logic both sides must agree on belongs there.
- Do not widen what the browser can reach without updating `docs/security.md` in the same commit. The gateway is the sole owner of daemon clients, and `docs/security.md` is the trust-boundary document, not a changelog.

## Visual changes

`npm test` runs in jsdom, which has no layout engine, so a fully green test suite cannot detect clipped text, cropped badges, overlapping controls, or broken spacing.

Because of that, any change that touches sizing, spacing, type, or any other rendered dimension must include a before/after screenshot from a real browser engine. WebKit is preferred, since this ships as an installed iOS PWA. How you produce the screenshot is up to you.

This requirement is intentional; more unit tests are not a substitute for it.

## Running the project

```sh
npm install
npm run dev      # gateway on 8787, Vite on 5173
npm test         # vitest, jsdom
npm run typecheck
```

`npm run dev` serves two ports, and they do not behave alike. Vite on 5173 is
the one you edit against; the gateway on 8787 is the one users install. The
service worker registers in production builds only, so anything touching
install, offline behaviour, push, or the app badge has to be checked with
`npm run build && npm start` against 8787. Verifying against the wrong port
reports success while the shipped app is unchanged.

## Before submitting

- `npm run typecheck` and `npm test` pass.
- Security-relevant changes include the matching update to `docs/security.md`.
- Visual changes include the before/after screenshots described above.
