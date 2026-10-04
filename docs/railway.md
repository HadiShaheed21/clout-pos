# Railway deployment

FloCafe’s Railway deployment uses its local SQLite database; it does not use
Supabase or PostgreSQL.

## Local development

Local development and Railway must use different database files. With no
database-path environment variables, `node dev-server.js` uses
`<project-root>/flo.db` and `<project-root>/backups`. Electron desktop builds
use their normal operating-system user-data directory. Neither default points
at a Railway volume.

Do not copy a client database into the repository or commit `flo.db`, a backup,
or `.env`. To use an isolated local database, set `FLO_DB_PATH` to a database
file outside `/data`, for example under your user profile. Run
`npm run build:frontend`, `npm run build`, then `node dev-server.js` for the
standalone local service.

The included `railway.toml` installs server dependencies without triggering the
Electron-only postinstall hook, rebuilds `better-sqlite3` for Railway's Node
runtime, builds the frontend and backend, and starts the standalone POS server.

In Railway, attach a persistent Volume to the service at `/data`, then configure
the service variables below. Railway does not select the mount automatically;
the explicit variables ensure FloCafe uses these persistent paths:

- `/data/flo.db` for the SQLite database
- `/data/backups` for local database backups and recovery files

On a new volume, startup creates the database and backup directory. On later
deployments, it opens the existing database in place and runs normal migrations;
it does not reset, replace, or copy over the database.

For a nonstandard persistent mount, configure `FLO_DB_PATH` and, optionally,
`FLO_BACKUP_DIR` to absolute paths on that mount. Do not set either value to a
path outside the persistent Volume.

Before the first deploy, create or attach the Railway Volume with mount path
`/data`. Set these service variables (not repository values):

```text
NODE_ENV=production
FLO_DB_PATH=/data/flo.db
FLO_REQUIRE_PERSISTENT_STORAGE=true
# The exact public Railway browser origin for this service:
FLO_ALLOWED_ORIGINS=https://pos-production-7f58.up.railway.app
```

`FLO_DB_PATH=/data/flo.db` makes the database path exactly `/data/flo.db`.
`FLO_REQUIRE_PERSISTENT_STORAGE=true` causes startup to fail instead of creating
an ephemeral local database when the volume is missing or not writable. The
health check is `GET /api/health`; Railway should use that path and port supplied
through its `PORT` variable. A healthy response reports `databaseEngine:
"sqlite"`, the database path, schema version, and persistent-storage readiness;
it does not include records, JWT secrets, or credentials.

`JWT_SECRET` is optional. When it is unset, FloCafe generates a random secret
for a fresh installation and persists it in the SQLite settings on `/data`, so
logins remain valid across restarts. Set `JWT_SECRET` only when a separately
managed secret is required; keep it stable for the lifetime of that client
database, because changing it invalidates existing sessions.

`FLO_ALLOWED_ORIGINS` is an exact comma-separated allowlist, not a wildcard. Use
the service's current public Railway URL above, replacing it only if Railway
assigns a different domain or a verified custom domain is used. Add a separate
origin only for a deliberately authorized browser client.

## Backup and restore

FloCafe creates consistent SQLite backups with WAL sidecars checkpointed so the
resulting `.db` file is self-contained. Railway backups in `/data/backups` survive
redeployment with the volume, but the volume is not an independent backup. An
owner should regularly download or copy verified backups to a separate secure
location. A SQLite snapshot is a full-fidelity copy and can contain password
hashes and database-held integration settings; it must never be emailed,
committed, or shared publicly. A configured `JWT_SECRET` remains an environment
variable; otherwise, FloCafe's generated JWT secret is stored in SQLite and is
included in the snapshot. Restore is a destructive owner operation: create and download a fresh
backup first, use the settings flow or the protected restore API only during a
maintenance window, and never upload a backup from an untrusted source.

Before deploying a code change locally, run `npm run build`,
`npm run build:frontend`, `npm run test:first-run`, `npm run test:backup`, and
the focused feature tests affected by the change. Never commit or share
`JWT_SECRET`, `.env`, database files, backups, OAuth credentials, or customer
data.

Do not use Railway’s volume wipe action for an existing POS database. The
database contains the owner account and all POS records; a new empty volume
intentionally shows first-run setup.

## Client provisioning and isolation

The browser never exposes the first-run wizard. An unprovisioned POS opens the
normal login page and reports that administrator provisioning is required. The
only route that can create the first owner is the existing host-local endpoint
`POST /api/auth/setup/initialize`; it accepts requests only from loopback, is
disabled after the first user is created, and stores the submitted password as a
bcrypt hash.

Provision a new client before giving them the public URL. In a Railway shell for
that client’s service, submit the documented JSON payload to the loopback API:

```sh
curl --fail --request POST \
  --header 'Content-Type: application/json' \
  --data-binary @- \
  "http://127.0.0.1:${PORT}/api/auth/setup/initialize"
```

Paste the JSON payload when prompted, then press `Ctrl-D`. It must include a
name, email, strong initial password, `terms_accepted: true`, store name,
country, currency, timezone, business type, setup profile, and service model.
Do not place a password in a command line, Git repository, or shared terminal
history. Give the initial password to the client through a secure channel; the
existing authenticated password-change API lets a signed-in user replace it.

Each client must use a **separate Railway service and separate persistent
volume**. SQLite is one database per deployment, not a multi-tenant database:
sharing `/data/flo.db` or a volume between clients is not supported and risks
data exposure. If `JWT_SECRET` is explicitly configured, it must be distinct
for every service.

The included Railway configuration already builds and serves the static
frontend with the API from the same service. If a client currently uses Vercel,
move its public domain to this Railway service and validate login there before
removing the Vercel project or its API rewrite. No Vercel configuration is
changed by this guidance.
