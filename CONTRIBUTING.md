# Contributing

## Development setup

```bash
npm install
npm run build       # TypeScript -> dist/
npm test            # unit tests (vitest)
npm run dev         # run from sources over stdio
```

Live suites need a test tenant (`APPMIXER_BASE_URL`, `APPMIXER_USERNAME`,
`APPMIXER_PASSWORD`):

```bash
node test/smoke.mjs            # stdio smoke
node test/smoke-http.mjs       # HTTP transport smoke
node test/e2e-authoring.mjs    # full authoring cycle
node test/golden-flows.mjs     # canonical descriptors + options/trigger-url
node evals/run.mjs             # LLM eval suite (costs real model tokens)
```

## Things to know before changing code

- `src/guide.ts` is generated — edit `docs/flow-authoring-guide.md` and run
  `npm run gen:guide`.
- Every tool must carry `title` and the applicable `readOnlyHint` /
  `destructiveHint`, keep its name ≤ 64 characters, and return failures as
  actionable `isError` results (see `safeHandler` / `describeError`).
- Keep outputs bounded: paginate lists, cap sizes, prefer summary+detail
  modes over dumps.
- If you change the authoring guide, tool descriptions or output formats,
  run the eval suite before and after — it is the regression test for the
  parts unit tests cannot see.

## Pull requests

Work happens on feature branches with PRs against `main`. CI must be green;
the live suites run automatically when the repository has tenant secrets
configured and skip otherwise.
