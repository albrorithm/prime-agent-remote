---
name: primea-ui-harness
description: Runs and extends the local Playwright browser harness for primeA-mobile-ui. Use when changing web UI components, Markdown or math rendering, mobile layout, scrolling, streaming behavior, CSS, browser accessibility, safe links, tables, or when a direct screenshot and DOM report would improve verification.
compatibility: Requires the repository-local ignored .ui-harness directory, Node.js, and Playwright Chromium.
---

# primeA UI harness

Use this project-scoped workflow to verify browser-visible changes directly. The harness renders real application components and production CSS at a mobile viewport without connecting to a real gateway.

## Safety and scope

- Work from the repository root.
- Keep `.ui-harness/` ignored and local unless the user explicitly asks to commit it.
- Never connect fixtures to a real backend or add credentials, tokens, private URLs, or identifying data.
- Do not treat ignored harness files as product changes. Run the normal project checks for every tracked source change.

## First check

Confirm the local harness exists:

```bash
test -f .ui-harness/package.json
```

If dependencies or Chromium are missing:

```bash
cd .ui-harness
npm install
npm run install-browser
```

Do not reinstall when the existing setup works.

## Standard verification

Run all browser cases:

```bash
cd .ui-harness
npm test
```

The suite checks:

- mobile document overflow and local table scrolling;
- console errors, page errors, failed requests, and unexpected external requests;
- serious or critical Axe accessibility violations;
- unsafe HTML and URL schemes;
- math, loose-list, and streaming DOM behavior;
- incremental streaming output against a fresh final render.

Then run the product checks from the repository root:

```bash
npm run test
npm run smoke
git diff --check
```

## Capture and inspect one case

Available cases are documented in `.ui-harness/README.md`. Capture one with:

```bash
cd .ui-harness
npm run capture -- markdown-math
```

The command writes these local artifacts:

```text
.ui-harness/artifacts/<case>/screenshot.png
.ui-harness/artifacts/<case>/dom.html
.ui-harness/artifacts/<case>/report.json
```

Inspect `report.json` for:

- empty `consoleErrors`, `pageErrors`, `failedRequests`, and `externalRequests`;
- `layout.document.horizontalOverflow === 0`;
- unexpected accessibility violations;
- the final rendered text and viewport dimensions.

Use the image attachment capability to view `screenshot.png`. Check clipping, spacing, glyph fallback, local scroll regions, contrast, and mobile readability. Do not rely only on a passing DOM assertion.

## Run the gallery interactively

```bash
cd .ui-harness
npm run dev
```

Open the local URL printed by Vite. Use the fixture selector and the streaming controls. Stop the server after inspection.

## Extend the harness

When a change needs a new fixture:

1. Add the case to `.ui-harness/src/cases.tsx`.
2. Add its ID to both case lists in `.ui-harness/tests/harness.spec.ts` and `.ui-harness/scripts/capture.mjs`.
3. Add a focused Playwright assertion for the behavior, not only a screenshot.
4. Run `npm test` inside `.ui-harness/`.
5. Capture and visually inspect the new case.
6. Run the normal product checks.

Prefer deterministic local data. Fix time, state, viewport, and streaming chunks. Avoid external assets and network calls.

## Failure handling

- Treat console errors, page errors, page-wide horizontal overflow, and failed same-origin requests as product or harness defects.
- Treat unexpected external requests as a safety failure.
- Record accessibility findings in the report. Fix product issues when practical instead of weakening the check.
- Scope security assertions to the fixture root so Vite's own module scripts are not mistaken for rendered content.
- If a screenshot and DOM disagree, trust neither alone; inspect the computed layout metrics and the relevant component CSS.
