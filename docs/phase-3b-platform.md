# Platform-team dependencies

> As of 2026-10-16. Point 4 (mcptools) is done; the rest stands. The remote transport
> (streamable HTTP, env/bearer auth modes, Docker) is finished in this repository and
> depends on nothing outside it. This document is the
> brief for the work the MCP server cannot solve on its own — raw material for tickets on
> the platform team. Context: the "Appmixer MCP 2.0" analysis and
> `docs/mcptools-endpoints.md`.

## What already works without the platform

| Mode | Use | Limitation |
|---|---|---|
| stdio (`appmixer-mcp`) | local clients (Claude Code/Desktop, IDEs) | credentials in the environment |
| HTTP `MCP_AUTH_MODE=env` | self-hosted, one user or team | one shared account for every client |
| HTTP `MCP_AUTH_MODE=bearer` | self-hosted, multi-user | the client has to send an `Authorization` header (Claude Code can, **claude.ai connectors cannot**); the token is a full 30-day user JWT |

## 1. OAuth bridge for claude.ai (blocks public connectors)

**Problem:** claude.ai connectors do not accept user-pasted bearer tokens — they require
OAuth 2.0 (CIMD preferred, DCR as a fallback; callback `https://claude.ai/api/mcp/auth_callback`).
We can add an OAuth authorization server to the MCP server (the SDK's `mcpAuthRouter`),
but **the authorization step needs Appmixer's own sign-in page** — we do not want to
collect passwords in a form of ours, which is an anti-pattern and does not work for SSO
tenants at all.

**What we need from the platform:**
- A redirect/ticket mechanism: the MCP server sends the user to the tenant login (Studio or
  a dedicated page) with a ticket; after signing in the user returns to the MCP server's
  callback, which exchanges the ticket for a token. The pattern already exists for
  third-party OAuth: `POST /auth/ticket` + `GET /auth/status/{ticket}`.
- It has to work for SSO (SAML/OIDC) tenants.

**Acceptance:** the user adds the connector URL on claude.ai, signs in to Appmixer in the
browser, and the connector is connected without copying a token by hand.

## 2. Personal access tokens, revocation and refresh

**Problem:** the only long-lived identity is a 30-day full user JWT (`GRIDD_JWT_TOKEN_EXP`):

- it cannot be revoked (after a leak the only options are deleting the user or rotating the
  tenant's JWT secret),
- its reach cannot be narrowed (the token can do everything the user can),
- there is no refresh endpoint outside SSO — renewal needs the password.

**What we need from the platform:**
- Personal access tokens: create, list, revoke, optional expiry, and a scope (at minimum a
  restriction to an ACL role or a list of route resources),
- or at least a revocable refresh token for the OAuth bridge in point 1.

**Acceptance:** the MCP server can hold a short-lived access token and renew it without a
password; an administrator can see issued tokens and invalidate them.

## 3. Official per-tenant hosting at `api.TENANT.appmixer.cloud/mcp`

**Problem:** today the remote server is self-hosted (Docker behind the customer's own
reverse proxy). For customers we want the MCP endpoint to be part of the tenant deployment.

**What we need from the platform / devops:**
- the `appmixer-mcp-http` image added to the tenant stack (compose/k8s),
- `/mcp` and `/healthz` routed on the tenant API domain, with TLS,
- configuration: `MCP_AUTH_MODE=bearer` (OAuth later), `APPMIXER_BASE_URL` pointing at the
  internal API,
- health-check monitoring.

**Acceptance:** a new tenant gets the MCP endpoint automatically, with a documented URL for
customers.

## 4. Merge mcptools (connectors PR #1117) — done

**Merged 2026-09-21.** The `appmixer.ai.mcptools` module is released and runs on
`api-dev-automated-00001.dev.appmixer.ai`. Of the defects listed in
`docs/mcptools-endpoints.md`, three are fixed: the missing `await` in `mcpListTools`, the
timeout returned as HTTP 200 (the polling route is gone entirely) and the fragile
`stateRemoveFromSet`. Two still stand and deserve a ticket of their own:

- the JWT travels in the SSE query string,
- the token is checked by a hand-rolled `jwt.verify` outside the auth pipeline.

**Where it stands for us:** `TOOLS=mcpgateway` is covered by a live suite
(`test/e2e-gateway.mjs`) that skips itself on a tenant without the module. It has not yet
had a real run — the repository secrets still point at the `your-saas` test tenant, which
does not have the module. Repointing them at the dev instance is three secret values and a
user, and needs no change to `ci.yml`.

## 5. Finer-grained ACL (nice to have)

Route ACL today only enforces the `flows` resource. For "this MCP token may read flows but
must not touch accounts, logs or stores" the enforcement in core has to cover more
resources. Related to token scopes in point 2 — worth solving together.

## Suggested order

Ordered by the question that decides this commercially: what blocks the claude.ai remote
connector. Only the first two items do.

1. **Hosting (3)** — pure devops, no security design to settle, and claude.ai cannot reach a
   URL that does not exist.
2. **OAuth ticket flow (1)** — the second and last gate. The design can start before hosting
   lands.
3. **Revocable tokens (2)** — not a gate, but the security debt a public connector would
   expose at scale. The revocable refresh token is the subset OAuth actually needs; full
   personal access tokens with scopes can follow.
4. **ACL (5)** — together with token scopes.

The earlier order put tokens first, which was right while bearer mode was the only remote
story. It is no longer: handing out 30-day JWTs is a reason not to publish widely, not a
reason the connector cannot exist.

The MCPB (desktop extension) route to claude.ai depends on none of this — it needs the npm
release and docs PR #157, both inside our own control. See "Directory readiness" in
`docs/gaps-and-roadmap.md`.
