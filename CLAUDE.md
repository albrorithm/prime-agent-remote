# Working notes

## A green test suite says nothing about layout

`npm test` runs vitest under jsdom, which has **no layout engine**: every element's box
reports zero pixels in every dimension. No test in this repo — present or future — can
observe a clipped box, a truncated label, an overlapping control, or a wrong computed font
size. A test that renders a badge, finds it in the document and checks its text passes
cheerfully while the digits are being cropped.

This is not a coverage gap to be closed with more tests. It is the wrong instrument.

Two bugs reached commits this way: the conversation header cropping a root session's
working-directory line at normal text size, and three count badges cropping their digits as
text scaled. Both sat behind a fully green suite.

**So: a change that touches sizing, spacing, type, or anything else with a rendered
dimension is not done when the tests pass. It is done when someone has looked at it.**

Look at it with `.ui-harness/` — a Playwright setup that renders the real components against
the production stylesheet in a real browser. It is deliberately gitignored and run by hand;
read its `README.md` first. There is no CI gate here, on purpose — the structural probe was
measured against a healthy tree and produced 175 warnings of which zero were genuine, because
"did this box refuse to grow?" has no mechanical answer. A 42px button refusing to grow is
correct; a 16px badge refusing to grow is a defect. That judgement is a person's.

`.ui-harness/ci-coverage-note.md` records the full reasoning and what an automated version
would have cost, if the question comes back.

### Use WebKit

This ships as an installed iOS PWA, so WebKit is the engine that matters and Chromium is the
one that doesn't. That distinction has already been load-bearing: the first version of the
text-scale change would have shifted every code block from 13px to 16px on WebKit, visible to
every user on day one, and Chromium alone did not show the severity. Both browsers are
installed in the local Playwright cache.

Headless WebKit is still not an iPhone. Safe-area insets are zero here and there is no
real-device text inflation, so anything depending on those needs the actual phone.

## Other standing notes

- Colocated `*.test.ts(x)` beside every module is the house rule.
- `src/protocol.ts` is the shared wire contract and the only module both tsconfigs compile;
  logic that the server and the web app must agree on belongs there.
- The gateway is the sole owner of daemon clients. `docs/security.md` is a deliberate
  trust-boundary document, not a changelog — a change that widens what the browser can reach
  updates it in the same commit.
