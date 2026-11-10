---
name: check-mcp-auth
description: Check an HTTP MCP server's OAuth sign-in with toolmenu when the server answers 401, a client (Claude, ChatGPT, VS Code, Cursor) can't connect or log in to it, or its OAuth discovery, protected resource metadata, PKCE or dynamic client registration is being set up or changed. Use for hosted or remote MCP servers behind OAuth, in any language.
---

# Checking an MCP server's sign-in

Before a client can log in to an HTTP MCP server, it discovers how: the 401 and its
`WWW-Authenticate` header, the protected resource metadata (RFC 9728), the
authorization server's metadata (RFC 8414 or OpenID Connect), PKCE and client
registration. `toolmenu auth check` makes those same requests, without logging in, and
says where a client that follows the MCP authorization spec would stop.

## When

- An HTTP server answers 401 and a client can't sign in, or signs in with one client
  and not another.
- After adding or changing OAuth on a server: the metadata documents, the `resource`
  value, the authorization server, registration.
- Before telling users a hosted server is ready for clients.

Not for a stdio server (no sign-in to discover), or a server that takes an API key in
a header: pass that with `headers` to `snapshot_menu` (check-mcp-menu).

## How

1. Get the server's public `https` URL, the one clients are given
   (`https://mcp.example.com/mcp`). The check is over https only; a `localhost`
   server needs a tunnel or a deployed preview.
2. Call `check_auth` with `url`. If the tool isn't there (an older toolmenu), run
   `npx -y toolmenu auth check <url>` (Node 22+). No credentials: the check is of what
   a client sees before it has any.
3. For a finding you don't understand, `explain_rule` with its rule id
   (`auth/resource-metadata`).

It sends a few unauthenticated GET and POST requests to the URL and to the metadata
addresses the server names. It never logs in, registers a client or stores a token.

## Reading the report

- `auth/discovery`: the 401 doesn't lead a client to the metadata, or the server
  couldn't be reached.
- `auth/resource-metadata`: the protected resource metadata is missing, or its
  `resource` isn't the server's URL. An error where the official SDK would refuse; a
  warning where only a client that follows RFC 9728 to the letter would (a parent
  path, a trailing slash).
- `auth/server-metadata`: the authorization server's metadata is missing or sits
  where the resource's belongs.
- `auth/pkce`: `code_challenge_methods_supported` is absent or lacks `S256`. With
  OpenID Connect metadata the provider may support PKCE and not advertise it; the
  finding says which.
- `auth/registration`: no dynamic registration, so users need a pre-registered client.
- A document toolmenu couldn't read (a 403, a 5xx, no answer) is reported as
  unchecked, not as missing. Don't tell the user it's missing; say it couldn't be read
  from here, and why.

Each finding ends with `→ Next:`. Fix it in the server's or the identity provider's
configuration and run the check again. A clean check says discovery is right; it
doesn't prove a login completes. For that the user signs in themselves:
`npx -y toolmenu auth login <url>`, in their own terminal, since it opens a browser.
Don't run `auth login` for them or ask for their credentials.
