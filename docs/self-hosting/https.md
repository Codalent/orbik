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

When something else already answers on ports 80 and 443 of the server — nginx serving other sites,
a load balancer — let it handle HTTPS, and keep Orbik's own proxy on plain HTTP on a loopback port.
In `.env`:

```sh
ORBIK_URL=https://orbik.example.com
ORBIK_TRUSTED_PROXIES=private_ranges
```

Leave `ORBIK_SITE_ADDRESS`, `ORBIK_BIND_ADDRESS` and the ports at their defaults: Orbik then
listens on `http://127.0.0.1:8080`, reachable from this machine only, and the proxy in front
forwards to it.

`ORBIK_TRUSTED_PROXIES` tells Caddy to believe what the proxy in front says about each request:
that it arrived over HTTPS (`X-Forwarded-Proto`) and who sent it (`X-Forwarded-For`).
`private_ranges` covers a proxy on the same machine, which reaches the published port from the
Docker network's gateway; for a proxy on another machine, name its address or range instead, and
set `ORBIK_BIND_ADDRESS` to an address of this server that it can reach.

> [!IMPORTANT]
> Without `ORBIK_TRUSTED_PROXIES`, every request reaches the API as plain HTTP. On an HTTPS address
> the session cookie is `Secure`, so it is never set: signing in seems to work and lands back on
> the sign-in page, and the API's log says `session.request_not_https`. The sign-in, setup and
> signup rate limits would also count everyone as the one proxy address.

### nginx on the same server

A server block for the domain, forwarding everything to Orbik:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name orbik.example.com;

    # Brand uploads are up to 20 MB.
    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # MCP clients may hold a response open as a stream.
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
```

Enable it, then get a certificate with [Certbot](https://certbot.eff.org), which adds the HTTPS
listener and the redirect from HTTP to the same block:

```sh
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d orbik.example.com --redirect
```

Run `docker compose up -d` after changing `.env`, then check from anywhere:

```sh
curl https://orbik.example.com/health
curl https://orbik.example.com/.well-known/oauth-authorization-server   # every address starts with ORBIK_URL
curl -sD - -o /dev/null https://orbik.example.com/v1/auth/session | grep -i set-cookie
```

The last one must print a `__Host-seo_session` cookie marked `Secure`. If it prints nothing,
`ORBIK_TRUSTED_PROXIES` is missing or does not cover the proxy.

Other proxies need the same three things: forward to the published port with the original `Host`,
send `X-Forwarded-Proto` and `X-Forwarded-For`, and allow request bodies of 20 MB on
`/v1/workspaces/*/brand/uploads`.
