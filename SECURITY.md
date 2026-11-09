# Security

## Reporting a vulnerability

Please report a vulnerability privately, through GitHub: the repository's **Security** tab →
**Report a vulnerability**. Do not open an issue or a pull request for it.

Say what you found, how to reproduce it, and what it lets someone do. We will acknowledge it
within three working days, keep you told of progress, and credit you when the fix is released
unless you would rather we did not.

## Scope

The code in this repository: the web app, the API (including the MCP endpoint and the OAuth
authorization server under `/oauth` and `/.well-known`), the agents worker and scheduler, the
packages, and the Docker setup. A self-hosted install's own configuration — its proxy, its
secrets, who can reach it — is its operator's.

Things worth knowing when you look:

- An MCP token or OAuth grant reads only the workspaces its holder can read; write access needs
  member or above on each.
- Brand images are served by signed links that expire in an hour.
- The crawlers refuse loopback and private addresses, and obey robots.txt.
- A new install is claimed with a one-time code printed to the API's log.

## Supported versions

The latest release (the newest `v*` tag, listed on the repository's Releases page and in
[CHANGELOG.md](CHANGELOG.md)). Fixes go into the next release and are not back-ported.
