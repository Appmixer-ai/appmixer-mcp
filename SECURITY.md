# Security

## Reporting a vulnerability

Please report suspected vulnerabilities privately via
[GitHub security advisories](https://github.com/Appmixer-ai/appmixer-mcp/security/advisories/new)
rather than opening a public issue. We will respond as quickly as we can and
credit reporters in the fix unless they prefer otherwise.

## Scope and model

- The server acts against an Appmixer tenant **as the user whose credentials
  it holds**; it adds no privileges of its own. Use a dedicated, non-admin
  Appmixer user for AI access.
- Appmixer access tokens are JWTs with a tenant-configured expiry
  (`GRIDD_JWT_TOKEN_EXP`, 30 days by default) and **cannot currently be
  revoked** — treat a leaked token as valid until expiry and rotate the
  user's credentials.
- In HTTP `bearer` mode every session is bound to the presenting token and
  the token is verified against the tenant before any session state exists.
  Terminate TLS in front of the server; it speaks plain HTTP.
- The MCPB bundle stores the token in the operating system's keychain via
  Claude Desktop's `sensitive` config handling.
