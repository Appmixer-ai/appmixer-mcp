# Where things stand

> Snapshot taken 2026-08-23, when development paused to wait for review,
> merge and the first release. Written so anyone (including us in a month)
> can pick the work up without rereading the whole history.
> Updated 2026-10-14: the connectors PR behind the MCP Gateway tools merged
> and the module is deployed on a dev instance, so the gateway can finally be
> tested live. Nothing else moved.

## The short version

v2 is feature-complete and verified, and it is waiting on people, not on
code. Everything lives on one branch behind one pull request that has not
been reviewed yet. Nothing is published, so no user can benefit from any of
it until that PR merges and v2 goes to npm.

## What exists

**Branch `feat/v2-core`** on the fork `petrolivka/appmixer-mcp`, 23 commits
ahead of the upstream `main` (which is still the v1 code), CI green on every
push including the live suites.

The server is a TypeScript rewrite on the current MCP SDK with **37 tools**
in three families — operating flows, authoring them, and the data around
them (stores, versions, modifiers, dead-letter queue) — plus dynamic tools
published by MCP Gateway components. It runs over **stdio**, over
**streamable HTTP** (sessions, `env`/`bearer` auth, Origin allowlist,
session cap, rate limiting), and ships as an **MCPB bundle** for Claude
Desktop.

Verification: 75 unit tests, five live suites against a test tenant in CI
(stdio and HTTP smoke, end-to-end authoring, golden descriptors), and 14 LLM
eval tasks scoring real agents — 14/14 on both Sonnet and Haiku.

## What is waiting, and on whom

| Item | Where | Waiting on |
|---|---|---|
| Code review and merge | [appmixer-mcp#5](https://github.com/Appmixer-ai/appmixer-mcp/pull/5) — open, 23 commits, 0 reviews | a reviewer |
| npm release of v2 | after the merge: `npm version <level>` and push the tag; `release.yml` does the rest | the merge |
| Customer documentation | [appmixer-docs-gitbook#157](https://github.com/Appmixer-ai/appmixer-docs-gitbook/pull/157) — draft, base `6.5` | the npm release (the page describes v2; today `npx appmixer-mcp` still installs 1.0.8) |
| MCP Gateway tools, live | [appmixer-connectors#1117](https://github.com/Appmixer-ai/appmixer-connectors/pull/1117) — **merged 2026-09-21** into `dev`; the module runs on `api-dev-automated-00001.dev.appmixer.ai` | the CI secrets being repointed at that instance (decided 2026-10-14) and a gateway lifecycle suite being written |
| claude.ai connector support | [`phase-3b-platform.md`](phase-3b-platform.md) | the platform team (OAuth bridge, personal access tokens) |

The platform items have the longest lead time. Filing them as tickets now
means they can run in parallel with everything else.

### Where the module is deployed

`appmixer.ai.mcptools.MCPGateway` is in the component catalogue of
**`api-dev-automated-00001.dev.appmixer.ai`** — the instance the local
`appmixer` CLI is aliased to, and the one #1117 ran its E2E on. Its plugin
routes answer 401 there (registered, auth required) while a bogus route under
the same prefix answers 404.

Our own test tenant does not have it: on
`api.your-saas.appmixer.cloud` the same routes answer 404, and that is the
tenant whose credentials CI holds today.

**Decision (2026-10-14): CI moves to the dev instance.** We are not going to
wait for the module to reach `your-saas`. This needs no change to
`ci.yml` — the workflow names no tenant, it reads `APPMIXER_BASE_URL`,
`APPMIXER_USERNAME` and `APPMIXER_PASSWORD` from the repository secrets, so
repointing is three secret values plus a user on the dev instance.

The four existing live suites travel well: they reference only
`appmixer.utils.*` core components (app events, controls, filters, HTTP
trigger — all verified present on the dev instance), bind no third-party
account and hardcode nothing about `your-saas`. Two things to keep in mind
when the switch happens:

- The `your-saas` user was deliberately non-admin, so the token's reach was
  limited by ACL. Whoever creates the CI user on the dev instance should keep
  that property instead of reusing an admin account.
- `dev-automated-00001` is a shared dev-automation instance — connector CI
  also runs there and it can be reset. If the live suites start failing for
  reasons that are not ours, that is the first thing to check.

### What #1117 changed for us

The merged module is not the one `docs/mcptools-endpoints.md` was written
against, so the findings there need re-checking against the final code:

- Findings 2, 5 and 6 are gone: tool discovery awaits an `httpRequest`,
  the flow-state polling (and with it the timeout returned as HTTP 200) was
  replaced by a direct component call whose output is the response,
  `receive()` answers 400 on malformed input and 404 on an unknown tool, and
  `stop()` deletes through the plugin route, which removes matching set
  members one by one.
- Findings 3 and 4 stand: the SSE endpoint still takes the JWT as a `token`
  query parameter and verifies it by hand against the secret in the database
  (only the fan-out moved from raw Redis to `context.pubSub*`).
  `src/tools/gateway.ts` still sends the token in the query string for that
  reason.
- Tool names changed: the gateway publishes `type`, `name`, `description`,
  `parameters` only, shortens UUID component ids so names fit 64 characters,
  and suffixes colliding names with a stable 8-character hash. Our
  fingerprint reconciliation should cope, but it has only been unit-tested.
- The `out` port now announces `{ webhook, componentId, flowId, tools }` once
  per flow start; the authoring guide does not mention it yet.

## Picking it back up

1. **Release first.** Merge #5, tag a release, confirm the workflow published
   to npm and attached the `.mcpb` to the GitHub release, then take
   docs#157 out of draft and ask for review.
2. **Test the gateway live** — possible today against
   `api-dev-automated-00001.dev.appmixer.ai`. Build a flow with an
   MCPGateway component there, run the stdio and HTTP smoke suites with
   `TOOLS=api,mcpgateway`, add the gateway lifecycle (start/stop flow →
   `tools/list_changed`) to the e2e suite, and bring
   `docs/mcptools-endpoints.md` in line with the merged code. The CI secrets
   move to the dev instance as part of this step.
3. **Then let usage steer.** The most useful input so far came from actually
   using the thing — a hand-written "order triage" brief exposed three gaps
   in one afternoon that no amount of desk review had found. Once the team
   is using it, their transcripts beat any list we could write today.
4. **Only then the backlog**, which is in
   [`gaps-and-roadmap.md`](gaps-and-roadmap.md): three API gaps remain
   (files, telemetry, third-party account connection), plus the P2 protocol
   items (structured output, progress notifications, prompts, logging
   notifications) and the P3 hosting-scale work that belongs with phase 3b.

## Things worth remembering

- **`src/guide.ts` and `src/version.ts` are generated.** Edit
  `docs/flow-authoring-guide.md` and `package.json` instead, then
  `npm run gen:guide` / `npm run build`.
- **Run the evals after touching the guide, tool descriptions or output
  formats.** They are the only regression test for the parts unit tests
  cannot see, and they cost real tokens, so they are not in CI.
- **Probe the API before trusting a field name.** Three separate times a
  reasonable-looking assumption was wrong: unprocessed messages use `err`
  and `messages`, a store record's value *is* the request body, and clone
  answers with `cloneId`. Each was caught by calling the tenant, not by
  reading code.
- **The test tenant** is `test_mcp@appmixer.ai` on
  `api.your-saas.appmixer.cloud`, a deliberately non-admin user with one
  connected Slack account, and CI holds the same credentials as secrets —
  but both are on their way out: per the decision above, CI moves to
  `api-dev-automated-00001.dev.appmixer.ai`, which is the only instance with
  the mcptools module. The local `appmixer` CLI already points there.
