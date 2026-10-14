# Honest assessment and roadmap

> As of 2026-08-20, against the MCP specification (2025-11-25), the Anthropic
> directory review criteria, and common expectations for a production server.
> This is a self-audit on two axes: how well the server plays the MCP role
> (protocol, safety, release), and how much of the Appmixer platform it can
> actually reach (API coverage). It names what is genuinely good, what is
> missing, and what we decided not to build. Platform-side blockers live in
> [`phase-3b-platform.md`](phase-3b-platform.md) and are not repeated here.

## Verdict in one paragraph

The server is a genuinely solid MCP citizen where it counts: tool design,
annotations, error quality, output discipline, auth handling and test coverage
are at or above what the directory review demands, and the eval harness is
something most published servers do not have at all. What separates it from a
finished product is the **outer ring**: release engineering, a handful of
protocol features we consciously skipped (structured output, progress,
prompts), and hardening for hostile traffic on the HTTP transport. The P1
section below closes the first and third of those; none of it was
architectural — the core did not have to change.

## Scorecard

| Area | State | Notes |
|---|---|---|
| Tool design & annotations | **strong** | 37 tools, one per action, read/write split, `title` + `readOnlyHint`/`destructiveHint` everywhere, names ≤ 64 enforced |
| Error quality | **strong** | `ApiError` with status/method/url, actionable `isError` results, targeted hints (invalid variable → `get_flow_variables`) |
| Output discipline | **strong** | pagination, projections, per-result caps, summary/detail modes |
| Platform API coverage | **good** | flows, components, accounts, logs, dead-letter queue, data stores, versions, modifiers; no files or telemetry — see below |
| Flow authoring | **strong** | guide (tool + resource), server-side validate loop, variables with leaf paths, dry-run, dynamic options, account binding, placeholder IDs |
| Testing | **strong** | 75 unit tests, 5 live suites in CI, 14 eval tasks measured on two models (14/14 both) |
| Transports | **good** | stdio + streamable HTTP (sessions, env/bearer, Origin allowlist) + MCPB bundle; no SSE resumability, in-memory sessions only |
| Protocol feature coverage | **fair** | tools + one resource + cancellation; no structured output, progress, prompts, logging notifications, elicitation |
| HTTP hardening | **good** | token verified before session, per-session binding, 4 MB cap, session cap, per-client rate limit, rejected-token cache |
| Release engineering | **good** | tagged release workflow (npm provenance + GitHub release with the bundle), CHANGELOG; bundle not signed yet, nothing published yet |
| Open-source hygiene | **missing → fixed** | SECURITY.md and CONTRIBUTING.md added together with this document |

## Gaps and proposals

### P1 — before the first public release — **done** (2026-08-20)

Items 1–4 below are implemented on `feat/v2-production-hardening`: release
workflow with tag/version check and npm provenance, generated version
constant, session cap plus per-client rate limiting and a rejected-token
cache, and cancellation threaded from the MCP layer to the HTTP client via a
request-scoped store. What remains open is signing the bundle (needs a
code-signing certificate) and the actual npm release.

1. **Release automation.** Nothing ships today: v2 is not on npm and the
   `.mcpb` exists only as a local build. Proposal: a `release.yml` workflow —
   on a version tag run build + tests, `npm publish --provenance`, build and
   `mcpb sign` the bundle, attach it to a GitHub release. Also bump
   `actions/checkout` and `actions/setup-node` to v5 (Node 20 runner
   deprecation warning). Effort: small.
2. **Single source of the version.** `src/server.ts` hardcodes
   `VERSION = '2.0.0'` next to `package.json`'s `version`; they will drift on
   the first patch release. Proposal: generate the constant in the build
   (same pattern as `gen:guide`) or read it in the release workflow and fail
   on mismatch. Effort: trivial.
3. **HTTP DoS hardening.** The sessions map is unbounded and nothing rate
   limits `/mcp`. Bearer-mode initialize also costs one upstream `GET /user`
   per attempt, so an attacker can make the server relay traffic at the
   tenant 1:1. Proposal: a `MAX_SESSIONS` cap (429 above it), a simple
   per-IP rate limit on initialize, and a short-TTL negative cache for
   rejected tokens. Effort: small.
4. **Request cancellation.** Tool handlers ignore the SDK's `extra.signal`.
   When a client cancels — most visible on `test_flow`, which can run for
   two minutes — the server keeps streaming and keeps the upstream call
   alive. Proposal: thread `extra.signal` through `safeHandler` into
   `AppmixerClient` (its methods already use `AbortController` internally).
   Effort: small-medium.

### P2 — protocol depth (quality, not correctness)

5. **Structured output.** Read tools return JSON serialized into a text
   block. The SDK supports `outputSchema` + `structuredContent`, which lets
   clients consume results without re-parsing prose and is where directory
   expectations are heading. Proposal: add output schemas to the read tools
   with stable shapes (`list_flows`, `get_flow_variables`, `validate_flow`,
   `get_component_options`), keeping the text block as a mirror. Effort:
   medium.
6. **Progress notifications.** `test_flow` streams component events
   internally but reports nothing until it finishes. The SDK exposes
   progress via `extra.sendNotification`; mapping `component:start/output`
   events to progress updates makes a 30–120 s call feel alive. Effort:
   small.
7. **MCP prompts.** Zero prompts today. Two canned workflows would package
   our own know-how: `build-flow` (brief → the authoring loop) and
   `diagnose-flow` (logs → descriptor → fix). Directory guidance explicitly
   encourages shipping these. Effort: small.
8. **Logging notifications.** v1 declared the `logging` capability; v2
   dropped it and logs to stderr only, so remote clients never see gateway
   reconnects or degradation notices. Proposal: re-declare `logging` and
   send `notifications/message` for gateway lifecycle events. Effort: small.
9. **Elicitation.** When `assign_account` finds several accounts for one
   service, the agent guesses. Spec-native elicitation ("which account?")
   fits exactly, gated on `clientCapabilities.elicitation` with the current
   behaviour as fallback. Host support is still rolling out, hence P2.
   Effort: small-medium.

### P3 — operations at official-hosting scale

10. **Session durability and horizontal scale.** Sessions are in-memory: a
    restart drops every client, and multiple replicas would need sticky
    routing. Fine for self-hosting; not for the per-tenant hosting planned
    in phase 3b. Proposal: SDK `EventStore` for SSE resumability plus a
    Redis-backed session map, delivered together with the hosting work.
    Effort: medium.
11. **Structured logs and metrics.** Logs are prefixed stderr lines; there
    are no counters (sessions, tool calls, upstream latency). Enough for
    npx, thin for a hosted service. Proposal: optional JSON log mode and a
    `/metrics` endpoint, again scoped to the hosting milestone. Effort:
    medium.
12. **Dependency automation.** No Dependabot/audit gate; the MCP SDK moves
    quickly. Proposal: Dependabot config for npm + actions with weekly
    cadence. Effort: trivial.

### A trade-off worth watching: tool count

The server now registers 37 tools. Every schema lands in the model's context
on connect, and the usual advice is to move past one-tool-per-action somewhere
around fifteen. We are well over that and it has not hurt: evals stay at 14/14
on two models and tool calls per task went down, not up, as tools were added —
because a specific tool beats an agent improvising against a generic one.

The number is still worth watching. If it becomes a problem, the fix is not a
generic `execute_action` tool (the directory review rejects those) but finer
`TOOLS` groups, so a client can register only what it needs: `flows` for
operating existing automations, `authoring` for building them, `data` for
stores and versions, `mcpgateway` for flow-published tools. The plumbing for
this already exists — `TOOLS` splits `api` from `mcpgateway` today.

### Known and accepted

- **The gateway live test skips itself on a tenant without the
  `appmixer.ai.mcptools` module.** The module merged (connectors #1117) and
  runs on the dev instance, so `test/e2e-gateway.mjs` covers the lifecycle
  there; on our own test tenant it is a no-op until the CI secrets move. See
  [`status.md`](status.md).
- **The eval runner under-reports cost on a task timeout**: the `result`
  event never arrives, so the missing cost counts as zero. Every run so far
  completed, which makes this a note-level fix rather than a priority.
- **`.mcpb` shasums differ between identical builds** (zip timestamps); we
  chose not to chase reproducible archives.
- **claude.ai connectors cannot connect** until the OAuth bridge exists —
  the top item of phase 3b, not solvable in this repository.

## API coverage

Measured against the endpoint inventory in the Appmixer CLI's API layer
(`appmixer-cli/src/api/*.js`): 32 modules, 214 method+path combinations. This
server reaches about two dozen of them. The raw ratio is meaningless on its
own — most of that surface is tenant administration that an end-user agent
must never touch — so what follows is grouped by whether the gap matters.

### Covered

| Domain | What we use |
|---|---|
| Flows | list, read, create, update (with `forceUpdate`), delete, start/stop, validate, test-run, trigger components |
| Components & apps | app list, component manifests, dynamic options (`/component/...`), trigger URL |
| Authoring support | flow variables (`/variables/:id/fetch`) |
| Accounts | list, per-flow bindings, assign to component |
| Observability | logs, unprocessed messages (list/read/retry/delete) |
| Events | app events |
| Identity | `/user` (token verification) |
| Gateway | mcptools gateways + SSE events |

### Gaps that matter — 1 to 5 **closed** (2026-08-21)

Data stores, flow versions and drafts, the modifier catalogue, flow clone and
flow metadata on write are implemented; the descriptions below stay as the
record of why each mattered. Files, telemetry and account connection remain
open, in that order.

### Gaps that matter

1. **Data stores** (`/stores`, `/store/*`, 15 endpoints). Flows read and write
   stores constantly, and an agent can neither inspect nor seed them. It
   cannot answer "what is in this store", cannot prepare fixture data for a
   flow it just built, and `get_components` will happily point it at store
   components whose `storeId` it then has to guess. **Highest-value gap.**
   Proposal: `list_stores`, `get_store_records`, `set_store_record`,
   `delete_store_record`, plus store creation.
2. **Flow versions and drafts** (`/flows/:id/versions*`, 8 endpoints;
   `/drafts/:id/publish`). We added editing without a safety net: an agent
   rewrites a descriptor with no snapshot to fall back to. Proposal:
   `list_flow_versions`, `create_flow_version` (before an edit),
   `restore_flow_version`. Pairs naturally with the editing guidance.
3. **Modifier catalogue** (`/modifiers`, `/modifiers/test`,
   `/modifiers/transform`). The guide hardcodes a list of `g_*` functions,
   which is exactly the kind of thing that silently goes stale. The platform
   can list them, and `/modifiers/test` can evaluate a lambda before it is
   embedded in a flow. Proposal: `list_modifiers`, `test_modifier`.
4. **Flow clone** (`POST /flows/:id/clone`). "Copy this flow and change X" is
   an obvious request that today forces a full descriptor round-trip.
   Proposal: `clone_flow`.
5. **Flow metadata on write.** `create_flow` and `update_flow` accept only
   name, descriptor and description; the API also takes `customFields`
   (used for filtering, and `list_flows` already supports `filter`),
   `sharedWith`, `notes`, `stage` and `wizard`. Proposal: widen both tools.
6. **Files** (`/files`, 8 endpoints). Components produce and consume files;
   an agent debugging such a flow cannot list or read them. Proposal:
   `list_files`, `get_file_metadata` (content only on request, size-capped).
7. **Charts and telemetry** (`/charts`, `/telemetry`, 8 endpoints).
   "How is this automation performing" is a fair question with no answer
   today. Proposal: read-only `get_telemetry`, and chart listing.
8. **Third-party account connection** (`/auth/ticket`,
   `/auth/:service/auth-url/:ticket`, `/auth/status/:ticket`). Today the
   guide simply tells the user to connect accounts in the UI. These
   endpoints would let an agent hand the user a ready authorization link and
   then wait for it. Genuinely useful, and the most security-sensitive item
   here — it should be designed deliberately rather than added casually.

### Deliberately out of scope

Tenant administration and deployment surface, which an end-user agent has no
business driving and which would widen the blast radius of a leaked token for
no benefit: ACL (`/acl*`), quotas, system endpoints (`/system/*`, audits,
drain, heapdump), service configuration, user and group management,
connector upload/delete (`/components` writes), price lists, public files,
listeners, backoffice config, automation-hub settings, and per-user service
config. Some of these could make sense in a future admin-scoped profile — as
a separate `TOOLS=admin` group with its own documentation — but not in the
default tool surface.

### Suggested order

Data stores first (it blocks whole classes of flows), then versions and
drafts (they make editing safe), then the modifier catalogue and clone (both
small), then metadata, files and telemetry. Account connection last, after a
deliberate security review.

## Directory readiness

| Criterion | Status |
|---|---|
| Read/write tool split, no catch-all method tool | ✅ |
| `title` + `readOnlyHint`/`destructiveHint` on every tool | ✅ |
| Tool names ≤ 64 characters | ✅ (enforced, including dynamic gateway tools) |
| Narrow, accurate descriptions; no prompt-injection patterns | ✅ |
| Actionable errors, validated inputs | ✅ |
| Reasonably sized responses | ✅ |
| First-party API ownership | ✅ (Appmixer's own API) |
| Public documentation | ⏳ docs PR #157, merges after the npm release |
| Test credentials for review | ⏳ to be prepared at submission |
| MCPB open source | ✅ MIT |
| Remote connector auth (OAuth) | ❌ blocked on phase 3b |

Practical consequence: an **MCPB directory listing is reachable now** (after
the npm release and docs merge); the **remote connector listing waits for
OAuth**.

## Suggested order

1. P1.1–P1.2 (release automation, version) — prerequisites for shipping v2.
2. P1.3–P1.4 (hardening, cancellation) — cheap and de-risk public exposure.
3. P2.7 and P2.8 (prompts, logging) — small wins, ship with the release.
4. P2.5–P2.6 (structured output, progress) — next minor version.
5. P2.9, P3.* — with elicitation host support and the phase-3b hosting work
   respectively.
