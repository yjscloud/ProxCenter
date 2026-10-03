# ProxCenter — Web Management Panel for Proxmox VE 8.x / 9.x

**English | [简体中文](README.md)**

[![License](https://img.shields.io/github/license/yjscloud/ProxCenter?color=blue)](LICENSE)
[![Release](https://img.shields.io/github/v/release/yjscloud/ProxCenter?sort=semver&color=success&label=release)](../../releases)
[![CI](https://github.com/yjscloud/ProxCenter/actions/workflows/ci.yml/badge.svg)](https://github.com/yjscloud/ProxCenter/actions/workflows/ci.yml)
[![Last commit](https://img.shields.io/github/last-commit/yjscloud/ProxCenter)](../../commits/main)
[![Stars](https://img.shields.io/github/stars/yjscloud/ProxCenter?style=flat)](../../stargazers)
![Python](https://img.shields.io/badge/python-3.11%2B-3776ab)
![React](https://img.shields.io/badge/react-18-61dafb)

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

Open `http://<server-ip>:8080` and sign in as `admin` with the password `ProxCenter@2026`.

> **Pull fails with `denied`?** GHCR packages are **private** by default, so nobody can pull them.
> The maintainer has to change the visibility to **Public** once, at
> <https://github.com/users/yjscloud/packages/container/proxcenter/settings>. To avoid GHCR
> entirely, use Docker Hub, where images are public by default:
> `PROXCENTER_IMAGE=docker.io/yjscloud/proxcenter:latest docker compose up -d`.

**Changing the passwords.** All three of them live in `docker-compose.yml`; search the file for
`★ 改这里`. The password lines look like this:

```yaml
ADMIN_PASSWORD: ${ADMIN_PASSWORD:-ProxCenter@2026}
```

`:-` is compose's "use this default" marker: *"if `.env` or the environment provides
`ADMIN_PASSWORD`, use that; otherwise use what follows"*. The `-`, `$`, `{` and `}` are **syntax
only** — the actual password is the `ProxCenter@2026` part. So change only the segment between
`:-` and the closing `}`:

```yaml
ADMIN_PASSWORD: ${ADMIN_PASSWORD:-MyPassw0rd2026}
```

Three lines need changing, all the same way: `ADMIN_PASSWORD` (panel login), `DB_PASSWORD`
(database), `MYSQL_ROOT_PASSWORD` (MySQL administrator). Then rerun `docker compose up -d`.

If you would rather not touch the compose file, create a `.env` next to it instead and write the
password itself after the equals sign:

```
ADMIN_PASSWORD=MyPassw0rd2026
DB_PASSWORD=MyPassw0rd2026-db
MYSQL_ROOT_PASSWORD=MyPassw0rd2026-root
```

Environment variables and `.env` win over the defaults in `docker-compose.yml`.

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

Images are built for amd64 (Proxmox VE itself is x86_64-only) and pulled from GHCR by default. To use Docker Hub instead:

```bash
PROXCENTER_IMAGE=docker.io/yjscloud/proxcenter:latest docker compose up -d
```

Upgrading is `docker compose pull && docker compose up -d`.

### 4. Bare metal deployment

If you would rather not run containers:

```bash
git clone https://github.com/yjscloud/ProxCenter.git
cd ProxCenter
sudo ./deploy.sh
```

The script installs the Python dependencies, builds the frontend, creates the database and
installs a systemd service, without asking anything. Port `8080`, database `proxcenter_panel`,
user `proxcenter`; `SECRET_KEY` and the admin password are generated randomly and the final
screen prints the panel URL and the initial password (shown only once). Re-running it does not
damage an existing installation.

Pass your own values on the command line if you want — it still will not ask:

```bash
sudo ./deploy.sh --port 9000 --mysql-root-password '<root password>' \
                 --db-name proxcenter_panel --db-user proxcenter --db-password '<db password>'
```

Useful flags:

| Flag | What it does |
|---|---|
| `--port 9000` | Change the port, written back to `.env` |
| `--service pc-panel` | Change the systemd unit name (several instances on one host) |
| `--user deploy` | User the service runs as, default `root` |
| `--skip-frontend` | Skip the frontend build and reuse the existing `dist/` (no Node on the host) |
| `--no-systemd` | Prepare the environment and dependencies only, install no service, no root needed |
| `--reconfigure` | Ask for each value; pressing Enter keeps the current one |
| `--lang zh\|en` | Interface language for the script itself |
| `--help` | Every option |

> `SECRET_KEY` must not be changed after it is generated: every stored PVE token and SMTP password
> was encrypted with it. That is why the script only overwrites the keys you pass explicitly when
> `.env` already exists.

To watch the logs in the foreground instead of installing a service:

```bash
npm run build && ./start-prod.sh
```

When `dist/` exists, FastAPI serves both the frontend and `/api` on port 8080, so the two are
same-origin and the VNC console's WebSocket works without any extra proxy.

### 5. Put it behind HTTPS

The panel does not speak TLS itself. Terminate it on 443 in Nginx or Caddy and proxy to 8080.
Proxy the WebSocket too, or the console will not connect:

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
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;   # the console is a long-lived connection
        proxy_buffering off;
    }
}
```

Turn on forced HTTPS on the panel side as well, otherwise hitting 8080 directly is still plain
HTTP:

```
FORCE_HTTPS=true
FORWARDED_ALLOW_IPS=127.0.0.1
```

Keep `FORWARDED_ALLOW_IPS` at your proxy's address. Widening it lets anyone claim
`X-Forwarded-Proto: https` and bypass the redirect. With Docker, put both into `.env` or
`docker-compose.yml`.

### 6. Service management

`./deploy.sh` installs a systemd unit, so the panel comes back after a reboot and restarts if the
process dies:

| Action | Command |
|---|---|
| Status | `systemctl status proxcenter` |
| Start / stop / restart | `systemctl start\|stop\|restart proxcenter` |
| Enable at boot | `systemctl enable proxcenter` |
| Follow the logs | `journalctl -u proxcenter -f` |

After a code change, a frontend-only edit just needs `npm run build`; a backend edit needs
`systemctl restart proxcenter`. To confirm it came up:

```bash
curl http://127.0.0.1:8080/api/health
# {"status":"ok","pve_connected":true,...}
```

> With Docker this section does not apply — the container already carries
> `restart: unless-stopped`.

---

## Features

**Virtual machines.** Four-step creation wizard (VMID, system, disks and NICs, cloud-init) for blank
VMs, template clones and cloud-image imports. Start / stop with graceful shutdown, a timeout and a
force-stop fallback; reboot, suspend, resume; delete is refused while the VM runs. Edit CPU, memory,
name, tags, on-boot and protection online; resize and move disks; migrate across nodes. Batch
operations run per target and report per target, so one failure does not stop the rest and you can
retry only the failures. Resetting a guest's user password goes through the QEMU guest agent when
available, otherwise cloud-init.

**LXC containers.** Containers use different PVE endpoints, so they get their own pages. Three-step
wizard (templates come from storages whose content type includes `vztmpl`), lifecycle, snapshots
(no memory state), full-only clones, migration. Resize rootfs and mount points; the IP lives in the
NIC line, so changing one needs a restart. Resetting the container root password runs `pct exec` on
the host over SSH, since neither a guest agent nor an API endpoint for running commands inside a
container exists.

**cloud-init template pipeline.** One action builds a template from a cloud image, waiting for each
task before the next step: shell VM, `importdisk`, attach as `scsi0`, cloud-init drive, resize,
convert. Any failure deletes the temporary VM. Images must live on dir / NFS / CIFS storage
(`importdisk` needs file-level access); LVM and ZFS can be the destination.

**Networking and firewall.** Node-level bridges, bonds and VLANs, with changes pending until you
press apply — the same behaviour as Proxmox, so a mis-edit cannot cut a node's network by accident.
The firewall wraps Proxmox's native one rather than reimplementing it, so the rules here are the
same data the PVE UI and `pve-firewall` see: three scopes, in/out rules with protocols, ports,
sources and destinations, PVE macros and ordering, plus security groups, IP sets and rule templates
pushed to many guests at once. Three permission levels, from view-only to cluster-wide.

**SSH login security.** Reads the SSH log of the **panel host** (other cluster hosts are not
reachable; the page says where the data came from), falling back from `/var/log/secure` to
`/var/log/auth.log` to `journalctl`. Only real authentication failures count, de-duplicated by the
sshd PID, so health checks and port scans do not raise the alarm. Failed sources are aggregated by
IP and can be banned in one click; fail2ban jails can be inspected, unbanned and configured, and
alerts reuse the monitoring channels with a recovery notice when an attack stops. Managed hosts let
you do the same on other machines, after confirming the SSH fingerprint once.

**Security baseline.** Scores the panel host and managed hosts — the same evaluation runs on both,
so the verdicts match — across SSH configuration, password policy, firewall, time sync, account
safety and kernel parameters, weighted by severity into an A–D grade. One-click hardening only
writes files the panel owns and rolls back if `sshd -t` or a `/proc` re-read fails. Changes that can
lock you out, such as disabling SSH password authentication, are deliberately excluded from it.

**Port and process anomaly detection.** Lists listening ports and flags reverse-shell shapes
(`/dev/tcp`, `nc -e`, `socat exec:`, `curl|sh`, executables running from `/tmp`). A heuristic, not
an antivirus: every hit names the rule that matched, and the panel never kills anything itself.

**Emergency response and audit.** Isolating a suspicious VM snapshots it first, then drops the
network, powers it off and enables protection — reverse that order and the evidence is gone.
Backups can be registered as protected so the panel refuses to delete them. `last` / `lastb` and
sudo / su entries are folded into the same audit table as the panel's own operations.

**Monitoring, snapshots, console.** Cluster dashboards, live node metrics over `/ws/metrics`, RRD
charts, disk capacity forecasting, Feishu webhook and mail notifications with per-user channels.
Snapshot and backup management including scheduled `vzdump` jobs. An in-browser noVNC console.

**Users, quota and audit.** Three built-in roles (`admin`, `operator`, `viewer`) plus
self-registration with admin approval. Every write is logged with the user, action, target, result,
details and source IP, and the last administrator cannot be deleted or demoted. One global VM count
limit covers both creation and clone, so repeated cloning cannot get around it.

---

## Configuration

Everything lives in `backend/.env` (Docker takes the same names as environment variables; see
`backend/.env.example` for the full list). Values can also be changed at runtime under
**Settings**, which takes precedence. The ones that matter:

| Variable | Default | Notes |
|---|---|---|
| `SECRET_KEY` | placeholder | **Required.** Signs login JWTs and encrypts stored secrets. A placeholder or fewer than 32 characters refuses to start. |
| `ADMIN_USERNAME` | `admin` | Account created on first start. |
| `ADMIN_PASSWORD` | empty | Password for it: empty, shorter than 12 characters or a common one refuses to start. |
| `FORCE_HTTPS` | `false` | Redirect plain HTTP with `308` and send HSTS. Terminate TLS in front of the panel. |
| `FORWARDED_ALLOW_IPS` | `127.0.0.1` | Which proxies may set `X-Forwarded-Proto`. Keep it at your proxy. |
| `LOGIN_MAX_FAILURES` / `LOGIN_LOCKOUT_MINUTES` | `5` / `15` | Login lockout, counted per account and per source IP. |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `720` | Access token lifetime. |
| `REFRESH_TOKEN_EXPIRE_DAYS` | `14` | Refresh token lifetime — how long a login can last. |
| `TOTP_REQUIRED_ROLES` | empty | Roles forced to set up two-factor authentication, for example `admin`. |
| `RATE_LIMIT_ENABLED` / `RATE_LIMIT_PER_MINUTE` / `RATE_LIMIT_AUTH_PER_MINUTE` | `true` / `300` / `30` | Request rate limits for `/api/*`. |
| `STEP_UP_REQUIRED` / `STEP_UP_WINDOW_MINUTES` | `true` / `5` | Destructive actions ask for your password again. |
| `PVE_HOST` / `PVE_PORT` / `PVE_TOKEN_ID` / `PVE_TOKEN_SECRET` | — | Initial Proxmox connection, editable in the UI. |
| `PVE_VERIFY_SSL` | `true` | Keep it on. Turning it off exposes your API token to a man in the middle. |
| `PVE_CONSOLE_USER` / `PVE_CONSOLE_PASSWORD` | empty | Needed for the VNC console. |
| `CORS_ORIGINS` | `http://localhost:5173` | Allowed frontend origins, comma separated. |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | — | MySQL connection. Only MySQL is supported. |

Create the database first — the tables are created on startup:

```sql
CREATE DATABASE proxcenter_panel CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

Mail (SMTP) has no environment variables: configure it under **Settings → Mail notifications**.
The password is encrypted with `SECRET_KEY` before it is stored and is never sent back to the
browser.

---

## Project layout

```
proxcenter/
├── Dockerfile                  multi-stage: Node builds the frontend, then a slim runtime
├── docker-compose.yml          user deployment: passwords inline, image + MySQL, one command
├── docker-entrypoint.sh        generates SECRET_KEY on first start and keeps it in the volume
├── deploy.sh                   bare-metal installer, idempotent
├── backend/
│   ├── run.py                  entry point
│   └── app/
│       ├── main.py             FastAPI app, routes, error handling
│       ├── pve.py              Proxmox API client (token + ticket auth)
│       ├── vmconfig.py         builds and parses VM / container configuration
│       ├── security.py         JWT sessions, RBAC, audit helpers
│       ├── store.py            MySQL: users, audit log, connection settings
│       └── routers/            one module per page — vms, lxc, templates, console, tasks,
│                               network, baseline, portguard, isolation, backups, users, audit
└── src/
    ├── api/                    axios client, types, endpoint wrappers
    ├── hooks/                  auth, toasts, task waiting, WebSocket
    ├── components/, pages/     layout, shared UI, screens
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

Three layers, none of which needs a real Proxmox host: pure-logic tests for configuration
building, permission matrices and bulk-operation partial failures; a simulated Proxmox HTTP server
for auth headers, task polling and error mapping; and full API tests through FastAPI's TestClient
covering RBAC, audit, firewall, SSH log parsing, the baseline, port heuristics and the
guest-password channels.

> The API tests use a separate `<DB_NAME>_test` database. Without the right to create it they skip
> instead of touching your real data.

Frontend:

```bash
npm run typecheck     # tsc --noEmit
npm run build         # tsc -b && vite build
npm run verify        # the three checks above plus i18n consistency
```

---

## Troubleshooting

**You can sign in, but the VM and storage lists are empty.** Open **Settings → Environment
self-check** first. This is the most common Proxmox API token trap: a token created in the web UI
has privilege separation on by default, so it starts with *no* permissions — reads that need
privileges return `403`, and endpoints like `/storage` return `200` with an empty array instead of
an error. The self-check asks Proxmox for the token's effective permissions and prints the
commands to fix it:

```bash
pveum acl modify / --tokens 'root@pam!panel' --roles PVEVMAdmin
pveum acl modify / --tokens 'root@pam!panel' --roles PVEDatastoreUser
pveum acl modify / --tokens 'root@pam!panel' --roles PVEAuditor   # node metrics need Sys.Audit
```

The tell-tale sign is `privsep: 1` in `pveum token list` together with an empty
`/access/permissions`.

**Connection fails with 502 although Proxmox answers pings.** Check whether the host running the
panel has `HTTP_PROXY` / `HTTPS_PROXY` set. The panel does not inherit them by default; set
`PVE_TRUST_ENV=true` only if it really must reach PVE through a proxy, otherwise add the Proxmox
address to `NO_PROXY`.

**The configuration looks right but the panel cannot reach the cluster.** Connection settings are
resolved as *database first, then `.env`*. If an address was saved earlier, the new value in
`.env` has no effect. Change it under Settings, or delete the `pve_connection` row from the
`settings` table and restart. An unreachable Proxmox does not stop the panel from starting — it
only logs a warning, which is what lets you get back in and fix the configuration.

**The console asks for a user name and password.** Proxmox design: an API token cannot access
`vncproxy`. Add a PVE account and password under Settings — ideally a dedicated account with only
`PVEVMUser`.

**The console connects but stays black.** Cloud images do not write boot output to the graphical
console. The panel configures `serial0` and `vga: serial0` when it builds a template; a
hand-made template needs those two lines added in PVE.

**Template building gets stuck at `importdisk`.** The image must be on dir / NFS / CIFS storage.
Storing the `.img` on LVM or ZFS fails, and the panel deletes the temporary VM when it does.

**Docker deployment: the container will not start or keeps restarting.** Almost always the
database password:

```bash
docker compose logs panel | tail -30     # look for Access denied / Can't connect
```

See the two notes at the end of [Docker deployment](#3-docker-recommended) for how to change them.

---

## Security notes

**Keys and passwords.** `SECRET_KEY` signs the login JWTs and is the encryption root for stored
secrets — a placeholder or fewer than 32 characters refuses to start. `ADMIN_PASSWORD` shorter
than 12 characters, empty or a common weak password also refuses to start. The backend enforces
both, so there is no way to ship the defaults by accident.

**HTTPS is expected in production.** Credentials and the API token travel in plain text over HTTP.
Set `FORCE_HTTPS=true` and terminate TLS in Nginx or Caddy. The proxy must send
`X-Forwarded-Proto`, and `FORWARDED_ALLOW_IPS` must stay at the proxy's address — widening it lets
a public request claim it is HTTPS and bypass the redirect. Keep `PVE_VERIFY_SSL=true` (the
default) so nobody can sit between the panel and Proxmox and take the token.

**Keep the Proxmox token narrow.** `--privsep 1` with precise ACLs limits the panel to what it
should touch. PVE's port 8006 does not need to be reachable from outside either: everything goes
through the panel's backend.

**Stored secrets are never sent to the browser.** `GET /api/config/connection` only reports
`token_secret_set: true/false` and leaves the field untouched when you save with it empty. The
SMTP password behaves the same. Administrators cannot read other users' webhooks or cloud
credentials.

**Sign-in has three layers.** A human check on the login page — off, slider (the default) or image
captcha — runs *before* the password is verified, so scripts cannot use "was the password right?"
as a signal; a failed captcha deliberately does **not** count towards the lockout, because
otherwise anyone could lock an account by submitting a wrong image repeatedly. Then failed
logins are counted per account and per source IP and stored in MySQL, so a restart does not clear
them. Around all of that sits a per-IP rate limit on `/api/*` with a tighter line for the
sensitive endpoints, which only trusts `X-Forwarded-For` from the proxies listed in
`FORWARDED_ALLOW_IPS` — a client cannot forge its way around it.

**Sessions can actually be revoked.** Both tokens are set as server-side `HttpOnly` cookies, so
JavaScript cannot read them and XSS cannot steal them. Logging out revokes the server session and
invalidates the token immediately rather than only clearing the browser. **Profile → Login
devices** lists every device and lets you kick them individually; "sign out everywhere" or an
administrator kicking a user invalidates every token that account ever received. Changing the
password does the same.

**Writes go through CSRF protection.** The CSRF cookie is readable on purpose so the frontend can
echo it back in `X-CSRF-Token`; every POST / PUT / PATCH / DELETE must match. A cross-site page
cannot read it and therefore cannot forge the request. WebSocket handshakes use the cookie and
check `Origin`, so tokens no longer appear in URLs or logs.

**Two-factor authentication** is available to everyone and can be enforced by role. Binding one
hands out eight recovery codes, shown once. The TOTP secret is encrypted with `SECRET_KEY` before
it is stored.

**Sensitive reads are audited and destructive actions need a second confirmation.** Reading the
connection settings, the mail configuration or the audit log itself all leave a record — "who
copied the cluster token" can only be answered by the traces of reads. Deleting a VM, changing
credentials, adding or removing accounts, editing cluster-level firewall rules or writing a
fail2ban policy all require re-entering your password even with a valid token; the backend answers
`403 + X-Step-Up: required` and the confirmation is good for `STEP_UP_WINDOW_MINUTES` minutes.

---

## Proxmox VE compatibility

The panel speaks the Proxmox REST API and uses one code path for **8.x and 9.x**, with no version
branches — a few fields are read opportunistically (present → used, absent → fallback). Both have
been exercised against real clusters for VM and container creation, start/stop and console. The
version string from `/version` is only displayed. The one version-sensitive feature is the
console: Proxmox's websocket endpoint accepts only a `PVEAuthCookie`, never an API token, on both
8.x and 9.x.

## License

[Apache-2.0](LICENSE)

## Links

- Website and live demo: <https://prox.yjscloud.com>
- Issues and feature requests: <https://github.com/yjscloud/ProxCenter/issues>
- Full documentation (Chinese): [README.md](README.md)

