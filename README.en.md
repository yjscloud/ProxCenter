# ProxCenter — Web Management Panel for Proxmox VE 8.x / 9.x

**English | [简体中文](README.md)**

[![License](https://img.shields.io/github/license/yjscloud/ProxCenter?color=blue)](LICENSE) [![Release](https://img.shields.io/github/v/release/yjscloud/ProxCenter?sort=semver&color=success&label=release)](../../releases) [![CI](https://github.com/yjscloud/ProxCenter/actions/workflows/ci.yml/badge.svg)](https://github.com/yjscloud/ProxCenter/actions/workflows/ci.yml) [![Stars](https://img.shields.io/github/stars/yjscloud/ProxCenter?style=flat)](../../stargazers) ![Python](https://img.shields.io/badge/python-3.11%2B-3776ab) ![React](https://img.shields.io/badge/react-18-61dafb)

A self-hosted web panel for Proxmox VE 8.x / 9.x. It manages QEMU virtual machines and LXC
containers end to end: a cloud-init template pipeline, networking and firewall, monitoring
dashboards, snapshots and backups, an in-browser VNC console, multi-user RBAC with an audit log,
plus a few security operations features (SSH brute-force protection, port and process anomaly
detection, security baseline hardening).

The host only needs Docker:

```bash
curl -fsSLO https://raw.githubusercontent.com/yjscloud/ProxCenter/main/docker-compose.yml
docker compose up -d
```

Then open `http://<server-ip>:8080` and sign in as `admin` with the password `ProxCenter@2026`
(how to change it: [Docker deployment](#3-docker-recommended)). Prefer bare metal instead?
`sudo ./deploy.sh` installs it as a system service — see
[bare-metal deployment](#4-bare-metal-deployment).

> **Keywords**: Proxmox VE panel · Proxmox web panel · PVE management UI · LXC manager ·
> cloud-init templates · self-hosted virtualization console · Proxmox alternative UI

**Stack**: Python 3.11+ / FastAPI / httpx · React 18 + TypeScript + Vite · MySQL 8

Live demo: <https://prox.yjscloud.com>

![ProxCenter dashboard](docs/screenshots/dashboard.png)

> [README.md](README.md) (Chinese) is the primary document. This page mirrors it in a condensed
> form.

## Contents

- [Deployment](#deployment): [API token](#1-create-a-proxmox-api-token) ·
  [permissions](#2-grant-permissions) · [Docker](#3-docker-recommended) ·
  [bare metal](#4-bare-metal-deployment) · [HTTPS](#5-put-it-behind-https) ·
  [service management](#6-service-management)
- [Features](#features) · [Configuration](#configuration) · [Project layout](#project-layout) ·
  [Tests](#tests) · [Troubleshooting](#troubleshooting) · [Security notes](#security-notes) ·
  [Compatibility](#proxmox-ve-compatibility) · [License](#license)

---

## Deployment

### 1. Create a Proxmox API token

The panel talks to Proxmox with an API token. Run this on a PVE node:

```bash
pveum user add panel@pve --comment "ProxCenter panel"
pveum user token add panel@pve panel --privsep 0
```

`--privsep 0` means the token inherits the user's permissions. The output gives `full-tokenid`
(for example `panel@pve!panel`) and the token secret — these go into the panel as **Token ID**
and **Token Secret**.

### 2. Grant permissions

```bash
pveum acl modify / --user panel@pve --roles PVEVMAdmin,PVEDatastoreUser,PVESDNUser
```

Or split them for least privilege:

| Capability | Role |
|---|---|
| Read-only monitoring | `PVEAuditor` |
| Power on / off, console | `PVEVMUser` |
| Create / delete / reconfigure / snapshot | `PVEVMAdmin` |
| Backups, ISO and template storage | `PVEDatastoreUser` (`PVEDatastoreAdmin` to write) |
| Bridges and VLANs | `PVESDNUser` |

> Proxmox does not let an API token open a VNC console — that endpoint only accepts a ticket
> derived from a user password. To use the console in the browser, also fill in a PVE user name
> and password under **Settings**. Without it the console is unavailable; everything else keeps
> working.

### 3. Docker (recommended)

The host only needs Docker — no Node, Python or MySQL:

```bash
curl -fsSLO https://raw.githubusercontent.com/yjscloud/ProxCenter/main/docker-compose.yml
docker compose up -d
```

Open `http://<server-ip>:8080` and sign in as `admin` / `ProxCenter@2026`.

> **Pull fails with `denied`?** GHCR packages are **private** by default, so an anonymous pull
> fails until the maintainer flips the visibility to **Public** once, at
> <https://github.com/users/yjscloud/packages/container/proxcenter/settings>.
> **Is `mysql:8.0` slow?** That is Docker Hub's network — configure a registry mirror on the host,
> or point the database image elsewhere:
> `DB_IMAGE=docker.m.daocloud.io/library/mysql:8.0 docker compose up -d`. `DB_IMAGE=...` must be on
> the same line as the command, or exported, or written into a `.env` — typing it on its own line
> only sets a shell variable that compose cannot see.

**Changing the passwords.** All three live in `docker-compose.yml`; search for `★ 改这里`. The
lines look like this:

```yaml
ADMIN_PASSWORD: ${ADMIN_PASSWORD:-ProxCenter@2026}
```

`:-` is compose's "use this default" marker: *"if `.env` or the environment provides
`ADMIN_PASSWORD`, use that; otherwise use what follows"*. The `-`, `$`, `{` and `}` are **syntax
only** — the actual password is the `ProxCenter@2026` part. Change only the segment between `:-`
and the closing `}`:

```yaml
ADMIN_PASSWORD: ${ADMIN_PASSWORD:-MyPassw0rd2026}
```

The three are `ADMIN_PASSWORD` (panel login), `DB_PASSWORD` (database) and `MYSQL_ROOT_PASSWORD`
(MySQL administrator). Or leave the file alone and put a `.env` next to it with the password itself
after the equals sign — `.env` wins over the defaults.

Two things worth knowing up front:

- **Passwords only take effect on first initialisation.** `ADMIN_PASSWORD` is used only while the
  database has no administrator yet, and MySQL reads `MYSQL_PASSWORD` only when its data directory
  is empty. Changing them later means either `docker compose down -v` (**which wipes the data**) or
  an `ALTER USER` by hand — the commands are at the bottom of `docker-compose.yml`. To change your
  *login* password afterwards, use Profile → Change password.
- **Leave `SECRET_KEY` alone.** It signs login JWTs *and* is the encryption root for the secrets in
  the database (PVE tokens, SMTP password). A value committed to a public repository would be a
  published key, so the container generates one on first start and keeps it in the `panel_data`
  volume. Changing it after you have data makes every stored secret undecryptable.

Images are built for amd64 (Proxmox VE itself is x86_64-only) and pulled from GHCR by default. To
use Docker Hub instead:
`PROXCENTER_IMAGE=docker.io/yjscloud/proxcenter:latest docker compose up -d`. Upgrading is
`docker compose pull && docker compose up -d`.

### 4. Bare-metal deployment

```bash
git clone https://github.com/yjscloud/ProxCenter.git
cd ProxCenter
sudo ./deploy.sh
```

The script installs the Python dependencies, builds the frontend, creates the database and installs
a systemd unit, without asking anything. Port `8080`, database `proxcenter_panel`, user
`proxcenter`; `SECRET_KEY` and the admin password are generated randomly and the last screen prints
the panel URL and the initial password (**shown only once**). Re-running it will not damage an
existing installation. Pass your own values if you want — it still will not ask:

```bash
sudo ./deploy.sh --port 9000 --mysql-root-password '<root password>' \
                 --db-name proxcenter_panel --db-user proxcenter --db-password '<db password>'
```

Useful flags: `--port` · `--service` (systemd unit name) · `--user` (default `root`) ·
`--skip-frontend` (reuse an existing `dist/`, no Node needed) · `--no-systemd` (prepare only, no
root) · `--reconfigure` (ask for each value) · `--help`.

> `SECRET_KEY` must not change after it is generated — every stored PVE token and SMTP password was
> encrypted with it. That is why the script only overwrites keys you pass explicitly when `.env`
> already exists.

To watch the logs in the foreground instead of installing a service:
`npm run build && ./start-prod.sh`. When `dist/` exists, FastAPI serves both the frontend and `/api`
on port 8080, so the two are same-origin and the console's WebSocket works without an extra proxy.

### 5. Put it behind HTTPS

The panel does not speak TLS itself. Terminate it on 443 in Nginx or Caddy and proxy to 8080 —
including the WebSocket, or the console will not connect:

```nginx
server {
    listen 443 ssl http2;
    server_name panel.example.com;
    ssl_certificate     /etc/letsencrypt/live/panel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.example.com/privkey.pem;
    add_header Strict-Transport-Security "max-age=31536000" always;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;        # needed by the console
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;    # tells the panel the outside is https
        proxy_read_timeout 3600s;                      # the console is long-lived
        proxy_buffering off;
    }
}
```

Turn on forced HTTPS on the panel side too, otherwise hitting 8080 directly is still plain HTTP:

```
FORCE_HTTPS=true
FORWARDED_ALLOW_IPS=127.0.0.1
```

Keep `FORWARDED_ALLOW_IPS` at your proxy's address — widening it lets anyone claim
`X-Forwarded-Proto: https` and bypass the redirect. With Docker, put both into `.env` or the compose
file.

### 6. Service management

`./deploy.sh` installs a systemd unit, so the panel comes back after a reboot and restarts if the
process dies:

| Action | Command |
|---|---|
| Status / start / stop / restart | `systemctl status\|start\|stop\|restart proxcenter` |
| Enable at boot | `systemctl enable proxcenter` |
| Follow the logs | `journalctl -u proxcenter -f` |

A frontend-only code change just needs `npm run build`; a backend change needs
`systemctl restart proxcenter`. Confirm it came up with
`curl http://127.0.0.1:8080/api/health`.

> With Docker this section does not apply — the container already carries
> `restart: unless-stopped`.

---

## Features

- **Virtual machines** — four-step creation wizard (blank, clone a template, or import a cloud
  image), power operations with graceful shutdown and force-stop fallback, online reconfiguration,
  disk resize and migration, batch operations that execute per target and let you retry only the
  failures, and guest password resets through the QEMU guest agent or cloud-init.
- **LXC containers** — their own pages (PVE uses different endpoints), three-step wizard, rootfs and
  mount point management, snapshots, full-only clones, migration, and root password resets over SSH
  via `pct exec` on the host.
- **cloud-init template pipeline** — one action builds a template from a cloud image, waiting for
  each task between steps, and deletes the temporary VM on failure. Images must live on dir / NFS /
  CIFS storage.
- **Networking and firewall** — node-level bridges, bonds and VLANs with changes pending until you
  apply them, plus a wrapper around Proxmox's native firewall: three scopes, in/out rules with
  protocols, ports, sources and destinations, PVE macros and ordering, security groups, IP sets and
  rule templates pushed to many guests at once.
- **SSH login security** — reads the panel host's SSH log (three-way source fallback, de-duplicated
  by sshd PID so scans raise no alarm), aggregates failed sources by IP for one-click banning,
  manages fail2ban jails and custom policies, and sends alerts with a recovery notice when an attack
  stops. Managed hosts extend all of it to other machines.
- **Security baseline and port scan** — the same evaluation runs on the panel host and managed hosts,
  scoring SSH configuration, password policy, firewall, time sync, account safety and kernel
  parameters, with one-click hardening that validates itself (`sshd -t`, `/proc` re-read) and rolls
  back on failure. The port scan lists listeners and flags reverse-shell shapes; it is a heuristic,
  never kills anything, and says which rule matched.
- **Emergency response** — isolating a suspicious VM snapshots it first, then drops the network,
  powers it off and enables protection. Backups can be registered as protected so the panel refuses
  to delete them.
- **Audit and monitoring** — `last` / `lastb` and sudo / su entries folded into the same audit table
  as the panel's operations, cluster dashboards, live node metrics over `/ws/metrics`, RRD charts,
  disk capacity forecasting, and Feishu webhook plus mail notifications with per-user channels.
- **Snapshots, backups and console** — snapshot and backup management including scheduled `vzdump`
  jobs, and an in-browser noVNC console (the backend proxies the WebSocket, so PVE never has to be
  exposed).
- **Users, quota and audit** — three built-in roles (`admin`, `operator`, `viewer`),
  self-registration with admin approval, every write logged with user, action, target, result,
  details and source IP, and one global VM count limit covering both creation and clone.

---

## Configuration

Everything lives in `backend/.env` (Docker takes the same names as environment variables; see
`backend/.env.example`). Values can also be changed at runtime under **Settings**, which wins. The
ones that matter:

| Variable | Default | Notes |
|---|---|---|
| `SECRET_KEY` | placeholder | **Required.** Signs login JWTs and encrypts stored secrets. A placeholder or fewer than 32 characters refuses to start |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / empty | First account. A password under 12 characters, empty or a common one refuses to start |
| `FORCE_HTTPS` | `false` | Plain HTTP is answered with `308` and HSTS |
| `FORWARDED_ALLOW_IPS` | `127.0.0.1` | Which proxies may set `X-Forwarded-Proto`. Keep it at your proxy |
| `LOGIN_MAX_FAILURES` / `LOGIN_LOCKOUT_MINUTES` | `5` / `15` | Lockout, counted per account and per source IP |
| `ACCESS_TOKEN_EXPIRE_MINUTES` / `REFRESH_TOKEN_EXPIRE_DAYS` | `720` / `14` | Token lifetimes — the latter is how long one login can last |
| `TOTP_REQUIRED_ROLES` | empty | Roles forced to set up two-factor authentication, for example `admin` |
| `RATE_LIMIT_ENABLED` / `RATE_LIMIT_PER_MINUTE` / `RATE_LIMIT_AUTH_PER_MINUTE` | `true` / `300` / `30` | Per-IP limits for `/api/*` and for the sensitive endpoints |
| `STEP_UP_REQUIRED` / `STEP_UP_WINDOW_MINUTES` | `true` / `5` | Destructive actions ask for your password again |
| `PVE_HOST` / `PVE_PORT` | empty / `8006` | Proxmox address (no protocol) and API port |
| `PVE_TOKEN_ID` / `PVE_TOKEN_SECRET` | empty | The token from step 1 |
| `PVE_VERIFY_SSL` | `true` | Keep it on. Turning it off exposes the API token to a man in the middle |
| `PVE_CONSOLE_USER` / `PVE_CONSOLE_PASSWORD` | empty | Needed for the VNC console — an API token cannot open one |
| `CORS_ORIGINS` | `http://localhost:5173` | Allowed frontend origins, comma separated |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | — | MySQL connection. Only MySQL is supported |

Create the database first — the tables are created on startup:

```sql
CREATE DATABASE proxcenter_panel CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

Mail (SMTP) has no environment variables: configure it under **Settings → Mail notifications**. The
password is encrypted with `SECRET_KEY` before it is stored and is never sent back to the browser.

---

## Project layout

```
proxcenter/
├── Dockerfile · docker-compose.yml · docker-entrypoint.sh   container packaging and deployment
├── deploy.sh                   bare-metal installer, idempotent
├── start.sh / start-prod.sh    dev servers / production (backend serves dist/)
├── backend/
│   ├── run.py                  entry point
│   └── app/
│       ├── main.py             FastAPI app, routes, error handling
│       ├── pve.py              Proxmox API client (token + ticket auth)
│       ├── vmconfig.py         builds and parses VM / container configuration
│       ├── security.py         JWT sessions, RBAC, audit helpers
│       └── routers/            one module per page — vms, lxc, templates, console, tasks,
│                               network, baseline, portguard, isolation, backups, users, audit
└── src/
    ├── api/ · hooks/           axios client, auth, toasts, task waiting, WebSocket
    ├── components/ · pages/    layout, shared UI, screens
    ├── i18n/                   Chinese and English strings
    └── styles/                 dark theme design system
```

---

## Tests

```bash
cd backend
../.venv/bin/python -m pip install -r requirements-dev.txt
../.venv/bin/python -m pytest        # roughly 1000 cases
```

Three layers, none needing a real Proxmox host: pure-logic tests for configuration building,
permission matrices and bulk-operation partial failures; a simulated Proxmox HTTP server for auth
headers, task polling and error mapping; and full API tests through FastAPI's TestClient covering
RBAC, audit, firewall, SSH log parsing, the baseline, port heuristics and the guest-password
channels. The API tests use a separate `<DB_NAME>_test` database and skip rather than touch your
real data when they cannot create it.

Frontend: `npm run typecheck` · `npm run build` · `npm run verify` (both, plus i18n consistency).
To check the built output without Nginx: `npm run build && npm run serve:dist` (port 8090).

---

## Troubleshooting

**You can sign in, but the VM and storage lists are empty.** Open **Settings → Environment
self-check** first. A token created in the Proxmox web UI has privilege separation on by default, so
it starts with *no* permissions — reads that need privileges return `403`, and endpoints like
`/storage` return `200` with an empty array instead of an error. The self-check asks Proxmox for the
token's effective permissions and prints the commands to fix it:

```bash
pveum acl modify / --tokens 'root@pam!panel' --roles PVEVMAdmin
pveum acl modify / --tokens 'root@pam!panel' --roles PVEDatastoreUser
pveum acl modify / --tokens 'root@pam!panel' --roles PVEAuditor   # node metrics need Sys.Audit
```

The tell-tale sign is `privsep: 1` in `pveum token list` together with an empty
`/access/permissions`.

**Connection fails with 502 although Proxmox answers pings.** Check whether the host running the
panel has `HTTP_PROXY` / `HTTPS_PROXY` set — the panel does not inherit them by default. Set
`PVE_TRUST_ENV=true` only if it really must reach PVE through a proxy, otherwise add the Proxmox
address to `NO_PROXY`.

**The configuration looks right but the panel cannot reach the cluster.** Connection settings are
resolved *database first, then `.env`*. Change it under Settings, or delete the `pve_connection` row
from the `settings` table and restart. An unreachable Proxmox does not stop the panel from starting
— it only logs a warning, which is what lets you get back in and fix it.

**The console asks for a user name and password**, because an API token cannot access `vncproxy`.
Add a PVE account under Settings, ideally one with only `PVEVMUser`. **It connects but stays black**
because cloud images do not write boot output to the graphical console — the panel configures
`serial0` and `vga: serial0` for templates it builds, but a hand-made template needs them added.

**Template building gets stuck at `importdisk`** — the image must be on dir / NFS / CIFS storage.

**Docker: the container will not start or keeps restarting.** Almost always the database password:
`docker compose logs panel | tail -30`, looking for `Access denied` / `Can't connect`. See the two
notes under [Docker deployment](#3-docker-recommended).

**The host-security pages read nothing** — inside a container, `/var/log` and `/proc` belong to the
container rather than the host. Mount them read-only as the comments in `docker-compose.yml`
describe if you want them.

---

## Security notes

**Keys and passwords.** A placeholder or short `SECRET_KEY`, and an empty or weak `ADMIN_PASSWORD`,
both refuse to start — the backend enforces it, so the defaults cannot ship by accident.

**HTTPS is expected in production.** Credentials and the API token travel in plain text over HTTP.
Set `FORCE_HTTPS=true` and terminate TLS in Nginx or Caddy, keep `FORWARDED_ALLOW_IPS` at the
proxy's address, and keep `PVE_VERIFY_SSL=true` so nobody can sit between the panel and Proxmox.
`--privsep 1` with precise ACLs keeps the token narrow, and PVE's port 8006 need not be reachable
from outside at all.

**Stored secrets never reach the browser.** `GET /api/config/connection` only reports
`token_secret_set`, and saving with that field empty keeps the existing value. The SMTP password
behaves the same, and administrators cannot read other users' webhooks or cloud credentials.

**Sign-in has three layers.** A human check runs *before* the password is verified, so scripts cannot
use "was the password right?" as a signal; a failed captcha deliberately does **not** count towards
the lockout, because otherwise anyone could lock an account by submitting a wrong image repeatedly.
Then failures are counted per account and per source IP in MySQL, so a restart does not clear them.
Around that sits a per-IP rate limit that only trusts `X-Forwarded-For` from the configured proxies.

**Sessions can actually be revoked.** Both tokens are `HttpOnly` cookies, so JavaScript cannot read
them. Logging out revokes the server session; **Profile → Login devices** lists every device, and
"sign out everywhere" or an administrator kick invalidates every token that account was ever issued —
changing the password does the same. Writes carry a `X-CSRF-Token` header echoed from a deliberately
readable `panel_csrf` cookie, and the WebSocket handshake uses the cookie plus an `Origin` check, so
tokens no longer appear in URLs.

**Two-factor authentication and step-up.** Available to everyone and enforceable by role; binding one
hands out eight recovery codes, shown once. Deleting a VM, changing credentials, editing
cluster-level firewall policy and similar actions require re-entering your password (plus a TOTP code
with 2FA on) even with a valid token. Sensitive *reads* — connection settings, mail settings, the
audit log itself — are audited too, because "who copied the cluster token" can only be answered from
the traces of reads.

---

## Proxmox VE compatibility

One code path for **8.x and 9.x**, with no version branches — a few fields are read
opportunistically. Both have been exercised against real clusters for VM and container creation,
start/stop and console. The version string from `/version` is only displayed, so upgrading Proxmox
does not require upgrading the panel.

## License

[Apache-2.0](LICENSE)

## Links

- Website and live demo: <https://prox.yjscloud.com>
- Issues and feature requests: <https://github.com/yjscloud/ProxCenter/issues>
- Full documentation (Chinese): [README.md](README.md)

