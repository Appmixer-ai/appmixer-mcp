# Appmixer MCP

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for the
[Appmixer](https://www.appmixer.com) workflow-automation platform. It lets LLM
clients (Claude, Cursor, VS Code, Windsurf, …) control and observe the flows of
an Appmixer tenant user, and dynamically exposes tools published by
"MCP Gateway" components running inside Appmixer flows.

## Requirements

- Node.js 20 or newer
- An Appmixer tenant and user account

## Getting started

Add the server to your MCP client. A typical configuration:

```json
{
  "mcpServers": {
    "appmixer": {
      "command": "npx",
      "args": ["appmixer-mcp"],
      "env": {
        "APPMIXER_BASE_URL": "https://api.YOUR_TENANT.appmixer.cloud",
        "APPMIXER_ACCESS_TOKEN": "<your-appmixer-access-token>"
      }
    }
  }
}
```

With Claude Code:

```bash
claude mcp add appmixer npx appmixer-mcp \
  -e APPMIXER_BASE_URL="https://api.YOUR_TENANT.appmixer.cloud" \
  -e APPMIXER_ACCESS_TOKEN="..."
```

## Desktop bundle (MCPB)

For Claude Desktop users without Node.js, the server also ships as an `.mcpb`
bundle: download it, double-click, and fill in the tenant URL and token in the
install dialog (the token is stored in the OS keychain).

```bash
npm run build:mcpb     # -> dist/appmixer-mcp-<version>.mcpb
```

The bundle is the recommended install for Claude Desktop today, because
Desktop's remote-connector flow requires OAuth, which the server does not
implement yet (see [`docs/phase-3b-platform.md`](docs/phase-3b-platform.md)).
For every other client, prefer `npx appmixer-mcp` or the remote server below.

## Remote server (streamable HTTP)

Besides stdio, the same server runs as a remote MCP endpoint:

```bash
npx appmixer-mcp-http     # or: docker compose -f docker-compose.example.yml up -d
```

Two auth modes (`MCP_AUTH_MODE`, auto-detected by default):

- **`env`** — the server uses `APPMIXER_*` credentials from its environment and
  serves that single user to every caller. For personal/team self-hosting only;
  never expose publicly.
- **`bearer`** — every MCP client sends its own Appmixer access token:
  `Authorization: Bearer <token>`. Multi-user; sessions are bound to the token.
  Example: `claude mcp add --transport http appmixer https://your-host/mcp --header "Authorization: Bearer <token>"`.

HTTP-specific environment: `MCP_HTTP_PORT` (default 3000; falls back to
`PORT` when unset, for platforms that inject it), `MCP_HTTP_HOST`
(default 127.0.0.1; the Docker image listens on 0.0.0.0 — terminate TLS in a
reverse proxy in front), `MCP_ALLOWED_ORIGINS` (comma-separated Origin
allowlist for browser clients; empty = reject all browser origins),
`MCP_SESSION_IDLE_TIMEOUT` (seconds, default 14400), `MCP_MAX_SESSIONS`
(default 200; further sessions get 429) and `MCP_RATE_LIMIT_PER_MINUTE`
(session attempts per client address, default 30, 0 disables).
Health check: `GET /healthz`.

Note: claude.ai custom connectors require OAuth and cannot send bearer headers —
that flow is tracked in [`docs/phase-3b-platform.md`](docs/phase-3b-platform.md).

## Configuration

| Variable | Description |
|---|---|
| `APPMIXER_BASE_URL` | **Required.** Your Appmixer tenant API URL, e.g. `https://api.YOUR_TENANT.appmixer.cloud`. |
| `APPMIXER_ACCESS_TOKEN` | Appmixer access token (JWT). Recommended over username/password. |
| `APPMIXER_USERNAME` | Appmixer username — only needed when no token is provided, or to let the server renew expired tokens automatically. |
| `APPMIXER_PASSWORD` | Appmixer password (see above). |
| `TOOLS` | Enabled tool groups, comma-separated. Default `api,mcpgateway`. |

### Authentication notes

- Prefer `APPMIXER_ACCESS_TOKEN`. Tokens expire (`GRIDD_JWT_TOKEN_EXP` system
  setting, `30d` by default) — when username/password are also provided, the
  server re-authenticates automatically on expiry.
- Consider a dedicated non-admin Appmixer user for MCP access so the token's
  capabilities are limited by ACL.

## Tools

### API tools (`TOOLS=api`)

| Tool | Kind | Description |
|---|---|---|
| `list_flows` | read | List flows (pattern filter, pagination). |
| `get_flow` | read | Flow metadata + component list; optionally the full descriptor. |
| `get_flow_status` | read | Runtime status of a flow. |
| `get_flow_logs` | read | Execution logs, filterable with Lucene query syntax. |
| `list_unprocessed_messages` | read | Messages parked by the default error handling (dead-letter queue). |
| `get_unprocessed_message` | read | One parked message in full: the error and the input that failed. |
| `retry_unprocessed_message` | write | Replay a parked message once the flow is fixed. |
| `delete_unprocessed_message` | destructive | Discard a parked message. |
| `start_flow` | write | Start a flow. |
| `stop_flow` | write | Stop a flow. |
| `delete_flow` | destructive | Permanently delete a flow. |
| `trigger_component` | write | Send a POST/PUT/PATCH/DELETE webhook request to a trigger component of a running flow. |
| `read_component_trigger` | read | Send a GET request to a trigger component that listens on GET. |
| `send_app_event` | write | Send a named App Event to the user's flows. |

### Flow authoring tools (`TOOLS=api`)

| Tool | Kind | Description |
|---|---|---|
| `get_flow_authoring_guide` | read | The complete guide to writing flow descriptor JSON (also exposed as the MCP resource `appmixer://guides/flow-authoring`). |
| `list_apps` | read | Apps/connectors available on the tenant. |
| `get_components` | read | Component summaries per app, or the full manifest of one component (ports, input fields, output variables). |
| `list_accounts` | read | Third-party accounts connected by the user. |
| `create_flow` | write | Create a flow from a descriptor; validates automatically. |
| `update_flow` | write | Replace a flow's descriptor/name; re-validates. |
| `validate_flow` | read | Server-side validation with per-component errors. |
| `get_flow_variables` | read | Exact `$.<componentId>.<port>.<field>` variable paths (with leaf fields) available to each component. |
| `test_flow` | write | Dry-run one component + its downstream graph with sample input, without starting the flow. |
| `get_component_options` | read | Resolve dynamic inspector/output-port options (channel pickers, sheet lists, generated variables) at runtime. |
| `get_trigger_url` | read | Public webhook URL of a trigger component — the building block for chaining flows. |
| `get_flow_accounts` | read | Which components need a connected account and what is assigned. |
| `assign_account` | write | Bind a connected account to a component. |

### Data, versions and modifiers (`TOOLS=api`)

| Tool | Kind | Description |
|---|---|---|
| `list_stores` / `create_store` | read / write | Data stores the flows read and write. |
| `get_store_records` | read | Records of a store, with the total count. |
| `set_store_record` | write | Create or overwrite one record (the value is stored verbatim). |
| `delete_store_record` | destructive | Delete one record. |
| `list_flow_versions` | read | Saved snapshots of a flow. |
| `create_flow_version` | write | Snapshot the current state before a risky edit. |
| `restore_flow_version` | destructive | Roll the flow back to a snapshot. |
| `clone_flow` | write | Copy a flow, optionally carrying its accounts over. |
| `list_modifiers` | read | The `g_*` modifier catalogue of this tenant, filterable. |

The intended authoring loop: read the guide → discover components → `create_flow`
→ fix `validate_flow` errors via `update_flow` → check paths with
`get_flow_variables` → dry-run with `test_flow` → `start_flow`.

All tools ship proper MCP annotations (`readOnlyHint`, `destructiveHint`), so
well-behaved clients auto-allow reads and always confirm destructive calls.
Errors are returned as actionable `isError` results with the API status and a
hint on how to fix the problem.

### MCP Gateway tools (`TOOLS=mcpgateway`)

Every running flow that contains an "MCP Gateway" component (from the
"MCP Tools" category) contributes its connected tools to this server. The tool
list updates live — starting or stopping such flows adds or removes tools
(standard `tools/list_changed` notifications).

Requires the `appmixer.ai.mcptools` module installed on the tenant. When the
module is missing, gateway tools are disabled gracefully and API tools keep
working. See [`docs/mcptools-endpoints.md`](docs/mcptools-endpoints.md) for the
module's endpoint documentation.

## Development

```bash
npm install
npm run build       # compile TypeScript to dist/
npm test            # unit tests (vitest)
npm run dev         # run from sources (tsx)

# Live tests against a real tenant:
APPMIXER_BASE_URL=... APPMIXER_USERNAME=... APPMIXER_PASSWORD=... node test/smoke.mjs
APPMIXER_BASE_URL=... APPMIXER_USERNAME=... APPMIXER_PASSWORD=... node test/e2e-authoring.mjs
# Gateway lifecycle — needs the appmixer.ai.mcptools module; skips without it:
APPMIXER_BASE_URL=... APPMIXER_USERNAME=... APPMIXER_PASSWORD=... node test/e2e-gateway.mjs

# After editing docs/flow-authoring-guide.md, regenerate the embedded copy:
npm run gen:guide
```

### LLM evals

`evals/` contains an agent-level benchmark: each task in `evals/tasks.json` asks
an LLM (via the `claude` CLI with this server mounted over `--mcp-config`) to
build a flow from a natural-language brief. The runner scores the result
objectively through the Appmixer API — flow created, passes validation,
expected components present, valid on the first try, tool-call count and cost —
and writes a JSON report to `evals/results/`.

```bash
node evals/run.mjs                 # all tasks (costs real LLM tokens!)
node evals/run.mjs --model haiku   # different model
node evals/run.mjs --only condition-branching --keep
```

Run it before releases or after changing the authoring guide, tool descriptions
or output formats — it is the regression test for the parts of this server that
unit tests cannot cover.

### Releasing

Releases are cut locally with `npm run release`
([commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version))
and published by GitHub Actions:

```bash
git checkout main && git pull && npm install
npm run release                    # bump, CHANGELOG, release commit + tag
git push --follow-tags origin main # the v* tag runs .github/workflows/release.yml
```

- The bump comes from the [conventional commits](https://www.conventionalcommits.org/)
  since the last tag (`fix:` → patch, `feat:` → minor, `!` → major). Force one
  with `npm run release -- --release-as minor` (or an exact version).
- `.versionrc.json` keeps `package.json`, `package-lock.json`,
  `mcpb/manifest.json` and `src/version.ts` on the same version.
- The workflow builds, tests, publishes to npm through trusted publishing
  (OIDC, no npm token) and attaches the `.mcpb` bundle to a GitHub release.
  Never run `npm publish` locally.

## Project documentation

- [`docs/status.md`](docs/status.md) — where the work stands and what it is waiting on
- [`docs/flow-authoring-guide.md`](docs/flow-authoring-guide.md) — the flow descriptor format (embedded in the server)
- [`docs/mcptools-endpoints.md`](docs/mcptools-endpoints.md) — the MCP Gateway module's endpoints and known issues
- [`docs/phase-3b-platform.md`](docs/phase-3b-platform.md) — work that depends on the Appmixer platform team
- [`docs/gaps-and-roadmap.md`](docs/gaps-and-roadmap.md) — honest self-assessment against MCP standards and the roadmap
- [`CHANGELOG.md`](CHANGELOG.md) · [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`SECURITY.md`](SECURITY.md)

## License

[MIT](LICENSE)
