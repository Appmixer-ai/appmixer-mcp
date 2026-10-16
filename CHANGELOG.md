# Changelog

## 2.0.0 (unreleased)

Complete rewrite in TypeScript on the current `@modelcontextprotocol/sdk`.

### Breaking changes

- Tool names are `snake_case`: `get-flows` → `list_flows`, `get-flow` →
  `get_flow`, and so on.
- `trigger_component` takes `method` as an enum of write methods
  (POST/PUT/PATCH/DELETE) and `body` as a JSON object; GET moved to the
  read-only `read_component_trigger`.
- `send_app_event` takes `data` as an object, not a JSON string.
- Requires Node.js 20+.
- License changed to MIT.

### Added

- **Flow authoring**: `create_flow`, `update_flow` (with `force` for running
  flows), `validate_flow`, `get_flow_variables` (exact variable paths with
  leaf fields), `test_flow` (dry-run over the platform's test endpoint),
  `list_apps`, `get_components` (summary and full-manifest modes),
  `get_component_options` (runtime-resolved pickers and generated
  variables), `get_trigger_url`, `list_accounts`, `get_flow_accounts`,
  `assign_account`, and an embedded flow authoring guide exposed as both a
  tool and the MCP resource `appmixer://guides/flow-authoring`.
- Component keys in descriptors may be readable placeholders — UUIDs are
  minted server-side and every reference is rewritten.
- Component types are verified against the tenant's catalogue before a flow
  is created or updated.
- **Remote transport**: `appmixer-mcp-http` (streamable HTTP) with per-session
  server instances, `env` and `bearer` auth modes (bearer tokens verified
  against the tenant before a session exists), an Origin allowlist,
  `/healthz`, a Dockerfile and a compose example.
- **Desktop bundle**: `npm run build:mcpb` produces an installable `.mcpb`
  for Claude Desktop (no Node.js required; token stored in the OS keychain).
- `get_flow_status`; dynamic MCP Gateway tools now reconcile by definition
  fingerprint, back off exponentially, re-check a missing plugin every five
  minutes and disable themselves on rejected credentials.
- Error-handling loop: `list_unprocessed_messages`, `get_unprocessed_message`,
  `retry_unprocessed_message` and `delete_unprocessed_message` reach the
  dead-letter queue where the platform's default per-component error handling
  ("Stop execution" / `onError: storeUnprocessed`) parks failed messages, so a
  failure can be inspected, fixed and replayed instead of being invisible.
- Data stores (`list_stores`, `create_store`, `get_store_records`,
  `set_store_record`, `delete_store_record`), flow version snapshots
  (`list_flow_versions`, `create_flow_version`, `restore_flow_version`),
  `clone_flow`, and `list_modifiers` for the tenant's `g_*` catalogue.
- `create_flow` and `update_flow` accept `custom_fields` (which `list_flows`
  can filter on) and `stage`.
- Test harness: 75 unit tests, live smoke/e2e/golden/gateway suites wired into CI,
  and an LLM eval suite (`evals/`) scoring real agents on 14 flow-building
  tasks.

### Hardening and release engineering

- Client cancellation is honoured: a cancelled tool call aborts the upstream
  Appmixer request instead of letting it run to completion.
- The HTTP transport caps concurrent sessions (`MCP_MAX_SESSIONS`), rate
  limits session creation per client (`MCP_RATE_LIMIT_PER_MINUTE`) and
  remembers tokens the tenant just rejected, so an unauthenticated caller
  cannot make the server relay traffic upstream.
- The version reported over MCP is generated from `package.json`, so the two
  cannot drift.
- A release workflow publishes to npm with provenance on a version tag and
  attaches the `.mcpb` bundle to the GitHub release.

### Fixed (relative to 1.x behaviour)

- Errors are no longer swallowed: failures surface as actionable `isError`
  results with the API status and a hint.
- Tokens are refreshed proactively with a single-flight re-login and one
  retry on 401.
- Outputs are paginated and size-capped instead of dumping whole flows and
  log histories.

## 1.0.8

Last release of the original JavaScript implementation (stdio only, eight
API tools, dynamic MCP Gateway tools).
