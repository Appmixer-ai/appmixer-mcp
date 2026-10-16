# The `appmixer.ai.mcptools` module — endpoint documentation

> Documentation for an undocumented dependency of the appmixer-mcp server.
>
> **Source:** PR [Appmixer-ai/appmixer-connectors#1117](https://github.com/Appmixer-ai/appmixer-connectors/pull/1117)
> (head: `apx-vero/appmixer-connectors@1ced0eb8`, branch `fix/mcp-gateway-outport-examples`).
> **As of 2026-08-17 that PR is OPEN and unmerged** (raised 2026-05-29, replaces #1023).
> The module is in no `appmixer-connectors` release, so appmixer-mcp v1.x depends on
> code that officially does not exist.

## Overview

The module ships the **MCPGateway** component (category "MCP Tools") and plugin routes.
MCPGateway runs inside a flow and exposes the tools wired to its ports:

- port `tools` → chains starting with `appmixer.ai.agenttools.ToolStart` (a tool defined by hand in the flow),
- port `mcp` → `appmixer.mcpservers.*.MCPServer` components (proxies to third-party MCP servers).

The appmixer-mcp server reads those gateways and publishes their tools to MCP clients.

## REST endpoints

Mount prefix: `/plugins/appmixer/ai/mcptools` (see `engine/src/context/Plugin.js`).

### `GET /gateways` — the user's gateways

- **Auth:** `jwt-strategy` (Bearer token).
- **Handler:** returns the contents of the service-state set `mcpgateways:user:<userId>`.
- **Response:** an array of objects:

```json
[
  {
    "flowId": "…",
    "componentId": "…",
    "webhook": "https://api.tenant…/flows/<flowId>/components/<componentId>",
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "<componentIdOrShortUuid>_<toolName>",
          "description": "…",
          "parameters": { "type": "object", "properties": { } }
        }
      }
    ]
  }
]
```

Entries are written to the set by `MCPGateway.start()` (`context.service.stateAddToSet`) and
removed by `MCPGateway.stop()`. Tool name format: for ToolStart chains
`<componentId>_<sanitizedLabel>` (truncated to 64 characters), for MCP servers
`<shortUuid(componentId)>_<toolName>` (short-uuid because of the 64-character limit).

### `POST /gateways` — broadcast `gateway-add`

- **Auth:** `jwt-strategy`.
- Stores nothing — only publishes `{ type: 'gateway-add', data: <payload> }` to the
  pub/sub channel `stream:mcp:events:<userId>`. Called by `MCPGateway.start()` (with an
  empty body) after writing to the service state. Returns `{}`.

### `DELETE /gateways/{gatewayId}` — broadcast `gateway-delete`

- **Auth:** `jwt-strategy`.
- Again deletes nothing — publishes `{ type: 'gateway-delete', id: <gatewayId>, data: … }`
  to the same channel. `gatewayId` is the component ID of the MCPGateway component. Called
  by `MCPGateway.stop()` after removing the service-state entry. Returns `{}`.

### `GET /events?token=<JWT>` — SSE event stream

- **Auth:** the `public` strategy plus a **hand-rolled** JWT check on the query parameter
  (`jwt.verify` against the secret read straight from the core `config` collection, type
  `JWTSecret`); `userId` comes from the `sub` claim.
- **CORS:** `origin: ['*']`.
- **Behaviour:** `text/event-stream`; an initial `: init`, then a `: ping` heartbeat every
  `SSE_HEARTBEAT_INTERVAL` ms (15 s by default); events are the JSON published to
  `stream:mcp:events:<userId>` (`gateway-add` / `gateway-delete`). Unsubscribes when the
  client disconnects.
- appmixer-mcp reacts to an event with `server.sendToolListChanged()`.

## Calling a tool (webhook)

`POST <gateway.webhook>` — that is, `POST /flows/<flowId>/components/<componentId>`, the
standard webhook endpoint of a trigger component in core — with the body:

```json
{ "function": { "name": "<prefix>_<toolName>", "arguments": { } } }
```

`MCPGateway.receive()` then:

1. splits `name` into `componentId` (expanding a short-uuid if needed) and `toolName`;
2. **MCP server component** → `POST /flows/<flowId>/components/<cid>?action=callTool` with
   `{ name, arguments }`, returning the output synchronously (errors come back as text, not 5xx);
3. **ToolStart chain** → sends `{ toolCalls: [...] }` to the `tools` port and polls the flow
   state under `correlationId` (300 ms interval, 120 s timeout, after which it returns
   `"Error: Tool timed out."` with HTTP 200);
4. malformed request → HTTP 400.

Tool discovery for MCP servers: `POST /flows/<flowId>/components/<cid>?action=listTools`.

## Findings to resolve before relying on the module

| # | Problem | Detail |
|---|---------|--------|
| 1 | **The PR is not merged** | The whole gateway feature of appmixer-mcp rests on an unapproved PR, which still carries 4 open TODOs (webhook flag in the manifest, UUID guard for `correlationId`, 400 on malformed JSON — partially addressed, e2e fix). |
| 2 | **Bug: missing `await` in `mcpListTools`** | `const { data } = context.callAppmixer({ … })` destructures a Promise, so `data` is always `undefined`. Tool discovery from MCP server components cannot work through `callAppmixer` (the commented-out `httpRequest` variant was correct). `MCPGateway.js`, `mcpListTools`. |
| 3 | **JWT in the SSE query string** | The token ends up in access logs and proxies. Justified by an `EventSource` limitation; the fix is a short-lived single-use ticket (the `POST /auth/ticket` pattern in core) instead of the full JWT. |
| 4 | **SSE bypasses the auth pipeline** | The hand-rolled `jwt.verify` against the secret from the database skips what `jwt-strategy` validates (user existence, group-context re-validation). A revoked or deleted user keeps listening to the stream until the token expires. |
| 5 | **Tool timeout returns HTTP 200** | `"Error: Tool timed out."` as a successful response — an MCP client should receive an error (`isError`), otherwise the LLM treats the timeout as a result. |
| 6 | **`stateRemoveFromSet` is fragile** | `stop()` removes an entry reconstructed from `stateGet('tools')`; if the tool definitions change between start and stop (the flow is edited), the entry may not match and the gateway is left dangling in the set. |

## Consequences for appmixer-mcp v2

- Keep the gateway feature behind a feature flag (`TOOLS=mcpgateway`) and degrade
  gracefully until the module is merged and released (today, when the endpoints are absent,
  v1 merely logs an error — v2 has to run cleanly in `api` mode).
- Push for #1117 to be merged with findings 2–5 fixed (owner: platform team / PR author).
- The v2 e2e tests have to cover the gateway lifecycle as well (start/stop flow → listChanged).
