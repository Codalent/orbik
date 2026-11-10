# A domain with HTTPS

Put the install on a domain of its own and the proxy gets and renews its certificate for you.
Claude.ai, Claude Desktop and ChatGPT can only sign in to an install on HTTPS.

## Setting it up

On a server with a public address, point a DNS name at it and set, in `.env`:

```sh
ORBIK_SITE_ADDRESS=orbik.example.com
ORBIK_URL=https://orbik.example.com
ORBIK_BIND_ADDRESS=0.0.0.0
ORBIK_HTTP_PORT=80
ORBIK_HTTPS_PORT=443
```

Then run `docker compose up -d` again. The proxy (Caddy) gets and renews the certificate itself.

HTTPS matters beyond privacy: Claude.ai, Claude Desktop and ChatGPT connect to Orbik from their own
servers and sign in over OAuth only on HTTPS, so they need the install on a public HTTPS address.
Sessions also use secure cookies when the address is HTTPS.

A plain-HTTP address other than `localhost` works for the web app, but browsers treat it as
insecure; use it only on a network you trust.

## Behind another proxy

If something else sits in front of the published port — a load balancer, nginx on the host — every
request reaches Caddy from that one address, and the sign-in, setup and signup rate limits are then
shared by everyone. Tell Caddy to trust that proxy's `X-Forwarded-For` in the global options block
at the top of [`deploy/Caddyfile`](../../deploy/Caddyfile), with the address ranges your proxy is
in:

```
{
	admin off
	servers {
		trusted_proxies static 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16
	}
}
```

Brand uploads are up to 20 MB, so a proxy in front must also allow request bodies that large on
`/v1/workspaces/*/brand/uploads`.
