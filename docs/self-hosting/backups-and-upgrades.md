# Backups and upgrades

Everything Orbik keeps is in MongoDB, so a MongoDB backup is a backup of the install. Upgrade by
moving to a release tag; the database is brought up to date when the processes start.

## Backups

Everything Orbik keeps is in MongoDB, including the brand images (GridFS, `brand_assets_files`).
Qdrant holds only the search index, which can be rebuilt from MongoDB, at the cost of embedding
everything again.

```sh
# Back up MongoDB to a file on the host
docker compose exec -T mongo mongodump --archive --gzip --db orbik > orbik-$(date +%F).archive.gz

# Restore it (into a fresh install, or over the current data)
docker compose exec -T mongo mongorestore --archive --gzip --drop < orbik-2026-10-31.archive.gz
```

To keep the search index too, copy Qdrant's volume while it is stopped:

```sh
docker compose stop qdrant
docker run --rm -v orbik_qdrant-data:/data -v "$PWD":/backup alpine tar czf /backup/qdrant.tgz -C /data .
docker compose start qdrant
```

Restoring is the reverse with `tar xzf` into the volume. Without a Qdrant backup, a restored install
re-indexes the Library on its own over the next scheduler passes, if `ORBIK_OPENAI_API_KEY` is set.

## Upgrades

Releases are tagged (`v0.1.0`, …) and listed with what changed in
[CHANGELOG.md](../../CHANGELOG.md) and on the repository's Releases page. Run a tag rather than
`main`, which moves between releases:

```sh
git fetch --tags
git checkout v0.1.0          # the release you are moving to
docker compose up -d --build
```

The API, the worker and the scheduler each bring the database up to date when they start: indexes
are created, and any **data migrations** the new release brings (`packages/migrations`) run once,
in order, under a lock — whichever process starts first does them and the others wait. A migration
that fails stops that process with its name in the log and is tried again on the next start. Back
up MongoDB before upgrading; going back to an older release after a migration has run is not
supported.

### Collections left by earlier releases

Builds of Orbik from before its first public release shipped SEO agents that now live outside
this repository, and a database those agents ran in still holds their collections. The migration
`2026-11-09-retire-seo-agents` removed what would otherwise be acted on — their schedules, setups
and queued runs, and pending Search Console sync jobs — and left their past runs and AI calls in
Activity and the AI call log as history. It drops no collection: these are kept until you decide
otherwise.

- `lighthouse_reports`, `change_watch_digests`, `technical_audits`, `agent_suggestions`,
  `overlap_scans`, `alt_text_images`
- `search_console_connections`, `search_console_oauth_states`, `search_console_property_days`,
  `search_console_page_days`, `search_console_query_days`, `search_console_reports`
- `competitor_setups`, `competitor_reads`, `competitor_pages`, `competitor_reports`,
  `competitor_site_maps`, `competitor_documents`, `competitor_profiles`, `competitor_changes`

Nothing reads or writes them. Deleting a workspace still removes its rows from them
(`RETIRED_COLLECTIONS` in [`packages/core/src/db/collections.js`](../../packages/core/src/db/collections.js)).
A Search Console connection's row is deleted with it, but Orbik no longer revokes its Google token;
to withdraw that access, remove the app at <https://myaccount.google.com/permissions>.

To drop them all, after a backup:

```sh
docker compose exec -T mongo mongosh orbik --quiet --eval '[
  "lighthouse_reports", "change_watch_digests", "technical_audits", "agent_suggestions",
  "overlap_scans", "alt_text_images",
  "search_console_connections", "search_console_oauth_states", "search_console_property_days",
  "search_console_page_days", "search_console_query_days", "search_console_reports",
  "competitor_setups", "competitor_reads", "competitor_pages", "competitor_reports",
  "competitor_site_maps", "competitor_documents", "competitor_profiles", "competitor_changes"
].forEach((name) => db.getCollection(name).drop())'
```

Without Docker, run the same `mongosh orbik --eval '…'` against your database.
