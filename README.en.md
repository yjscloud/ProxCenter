# ProxCenter — Web Management Panel for Proxmox VE 8.x / 9.x

**English | [简体中文](README.md)**

[![License](https://img.shields.io/github/license/yjscloud/ProxCenter?color=blue)](LICENSE)
[![Release](https://img.shields.io/github/v/release/yjscloud/ProxCenter?sort=semver&color=success&label=release)](../../releases)
[![CI](https://github.com/yjscloud/ProxCenter/actions/workflows/ci.yml/badge.svg)](https://github.com/yjscloud/ProxCenter/actions/workflows/ci.yml)
[![Last commit](https://img.shields.io/github/last-commit/yjscloud/ProxCenter)](../../commits/main)
[![Stars](https://img.shields.io/github/stars/yjscloud/ProxCenter?style=flat)](../../stargazers)
![Python](https://img.shields.io/badge/python-3.11%2B-3776ab)
![React](https://img.shields.io/badge/react-18-61dafb)

A **self-hosted** web panel for **Proxmox VE 8.x / 9.x**. It manages QEMU virtual machines and
**LXC containers** end to end — a cloud-init template pipeline, networking and firewall,
monitoring dashboards, snapshots and backups, an in-browser console (VNC / serial), multi-user
RBAC with an audit log — and goes beyond the basics with SSH brute-force protection, port and
process anomaly detection and security baseline hardening.

```bash
sudo ./deploy.sh      # backend + frontend + database + systemd service, prints the login
```

> **Keywords**: Proxmox VE panel · Proxmox web panel · PVE management UI · LXC manager ·
> cloud-init templates · self-hosted virtualization console · Proxmox alternative UI

**Stack**: Python 3.11+ / FastAPI / httpx (async) · React 18 + TypeScript + Vite +
TanStack Query + Recharts · MySQL 8 (panel users, audit log, connection settings)

![ProxCenter dashboard](docs/screenshots/dashboard.png)

> The [Chinese README](README.md) is the primary document and covers every screen in detail.
> This page is a condensed English version: quick start, configuration essentials and
> security notes.

## Contents

- [Highlights](#highlights)
- [Requirements](#requirements)
- [Quick start](#quick-start)
  - [1. Create a Proxmox API token](#1-create-a-proxmox-api-token)
  - [2. Grant permissions](#2-grant-permissions)
  - [3. Run ProxCenter](#3-run-proxcenter)
- [Configuration](#configuration)
- [Security notes](#security-notes)
- [Development and tests](#development-and-tests)
- [Proxmox VE compatibility](#proxmox-ve-compatibility)
- [License](#license)

## Highlights

- **Virtual machines** — create (blank / clone a template / import a cloud image), power
  operations with graceful shutdown and force-stop fallback, edit CPU / memory / name / tags,
  disk resize, move disks between storages, live migration across nodes, batch operations.
- **LXC containers** — dedicated wizard, rootfs and mount points (`mpN`), resize, snapshots,
  serial console, clone and migrate. Containers are matched to their own API endpoints, not
  treated as VMs.
- **cloud-init template pipeline** — build a template from a cloud image step by step (download,
  import, configure, convert, seal) with per-step task waiting, then clone from it.
- **Resources and quotas** — reusable *resource specs* (cores / memory / disk) and per-user
  issuance quotas, so a self-service deployment cannot exceed what you allow.
- **Networking** — bridges, VLAN tags, static or DHCP addressing per interface, IP pools with
  automatic free-address allocation, and manual IP binding shown in the VM list.
- **Firewall / security groups** — datacenter, node, VM and container scopes, rule templates
  pushed to many guests at once, aliases and IP sets.
- **SSH login security** — log parsing for accepted / failed logins, fail2ban integration,
  per-host ban and unban, attack notifications and a known-IP allow list.
- **Security baseline** — audit and harden SSH, password policy, firewall, time sync and
  kernel parameters across the panel host and managed hosts, with automatic rollback when a
  change would lock you out.
- **Port and process anomaly detection** — unexpected listeners, sensitive ports, reverse-shell
  signatures, deleted executables still holding sockets, with a whitelist and cooldown to keep
  false positives down.
- **Emergency response** — isolate a suspected VM (link down + firewall) and protect backups
  from deletion, in one guarded action.
- **Monitoring** — node, VM and container metrics with history, alerts, notification channels
  (mail / webhook / bots) and per-user isolation of integrations.
- **Snapshots and backups** — create, roll back and delete snapshots; browse node backups.
- **Console** — VNC for QEMU, serial terminal for containers, embedded in the panel.
- **Users and audit** — roles and fine-grained permissions, two-factor authentication,
  self-registration with admin approval, login lockout, rate limiting, and an audit log of
  every write operation.
- **Reset a guest's user password** — from the guest list, via the QEMU guest agent (instant),
  cloud-init (on next boot) or the host over SSH for containers. See [Security notes](#security-notes).

## Requirements

| Component | Version |
|---|---|
| Proxmox VE | 8.x or 9.x |
| Python | 3.11 or newer |
| Node.js | 18 or newer (only needed to build the frontend) |
| MySQL | 8.x (MariaDB also works) |

## Quick start

### 1. Create a Proxmox API token

Run this on a Proxmox node. Create a dedicated user rather than using `root` directly:

```bash
pveum user add panel@pve --comment "ProxCenter panel"
pveum user token add panel@pve panel --privsep 0
```

`--privsep 0` means the token inherits the user's permissions. The command prints
`full-tokenid` (for example `panel@pve!panel`) and the token secret — put them into the panel
as **Token ID** and **Token Secret**.

> If you keep privilege separation enabled (the Proxmox default when creating a token in the
> web UI), the token starts with **no** permissions. Reading then returns `403`, or worse,
> `200` with an empty list. The panel's **Settings → Environment self-check** asks Proxmox for
> the effective permissions and tells you what to grant.

### 2. Grant permissions

```bash
# Manage VMs: create, start/stop, snapshot, console
pveum acl modify / --user panel@pve --roles PVEVMAdmin,PVEDatastoreUser,PVESDNUser
```

Split the roles if you prefer least privilege:

| Capability | Role |
|---|---|
| Read-only monitoring | `PVEAuditor` |
| Power on / off, console | `PVEVMUser` |
| Create / delete / reconfigure / snapshot | `PVEVMAdmin` |
| Backups, ISO and template storage | `PVEDatastoreUser` (`PVEDatastoreAdmin` to write) |
| Bridges and VLANs | `PVESDNUser` |

> **Important**: Proxmox does not allow an API token to open a VNC or serial console — those
> endpoints only accept a ticket derived from a user password. To use the console in the
> browser, also fill in a PVE **user name and password** in the panel settings
> (`console_user` / `console_password`). Without it the console is disabled; everything else
> keeps working.

### 3. Run ProxCenter

**Option A — one command (recommended).** On the machine that will host the panel:

```bash
git clone https://github.com/yjscloud/ProxCenter.git
cd ProxCenter
sudo ./deploy.sh
```

`deploy.sh` is idempotent and runs without asking anything: it checks and installs system
dependencies, creates `.venv`, generates `backend/.env` with a random `SECRET_KEY`, database
password and initial admin password, creates the database and its MySQL user, builds the
frontend, installs a systemd service and finally prints the panel URL together with the
**one-time initial admin password** — change it right after your first login
(user menu → **Profile** → change password).

Useful flags: `--reconfigure` (ask for port / database / passwords instead of using defaults),
`--skip-frontend` (reuse an existing `dist/`), `--no-systemd` (prepare everything, install no
service), `--help` (all options).

**Option B — manual, for development:**

```bash
# backend
cd backend
python -m venv ../.venv && source ../.venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python -c "import secrets; print('SECRET_KEY=' + secrets.token_urlsafe(48))"
python -c "import secrets; print('ADMIN_PASSWORD=' + secrets.token_urlsafe(16))"
# put both values into backend/.env — the backend refuses to start without them
python run.py                      # listens on 0.0.0.0:8080

# frontend (second terminal)
npm install
npm run dev                        # http://localhost:5173, /api proxied to 8080
```

Open <http://localhost:5173> and sign in as `admin` with the `ADMIN_PASSWORD` you set. On first
start the panel creates the administrator account; a weak or empty password makes it refuse to
start, so there is no default password. Then do two things: fill in host / token ID / token
secret under **Settings → Proxmox connection**, and change the admin password.

The generated API documentation is at <http://localhost:8080/api/docs>.

## Configuration

All settings live in `backend/.env` (see `backend/.env.example`) and can afterwards be changed
at runtime under **Settings**, which takes precedence. The essentials:

| Variable | Default | Notes |
|---|---|---|
| `SECRET_KEY` | placeholder | Signs the login JWTs **and** encrypts stored secrets (PVE tokens, SMTP password). A placeholder or fewer than 32 characters refuses to start; changing it later makes existing ciphertext unreadable. |
| `ADMIN_USERNAME` | `admin` | Account created on first start. |
| `ADMIN_PASSWORD` | empty | Password for that account: empty, shorter than 12 characters or a common one refuses to start. `deploy.sh` generates a random one. |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | — | MySQL connection. Create the database first: `CREATE DATABASE proxcenter_panel CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;` — tables are created on startup. |
| `PVE_HOST` / `PVE_PORT` / `PVE_TOKEN_ID` / `PVE_TOKEN_SECRET` | — | Initial Proxmox connection (editable in the UI). |
| `PVE_VERIFY_SSL` | `true` | Keep it on. Set to `false` only for a self-signed or expired PVE certificate — it exposes your API token to a man in the middle. |
| `PVE_CONSOLE_USER` / `PVE_CONSOLE_PASSWORD` | empty | Needed for VNC / serial console (see above). |
| `FORCE_HTTPS` | `false` | Redirect plain HTTP with `308` and send HSTS. Terminate TLS in front of the panel (Nginx / Caddy). |
| `FORWARDED_ALLOW_IPS` | `127.0.0.1` | Which proxies may set `X-Forwarded-Proto`. Widening this to `0.0.0.0` lets anyone claim "I am HTTPS" and bypass `FORCE_HTTPS`. |
| `STEP_UP_REQUIRED` / `STEP_UP_WINDOW_MINUTES` | `true` / `5` | Destructive actions (delete, change credentials, reset a guest password) ask for your password again. |
| `LOGIN_MAX_FAILURES` / `LOGIN_LOCKOUT_MINUTES` | `5` / `15` | Login lockout per account and per source IP. |
| `RATE_LIMIT_ENABLED` / `RATE_LIMIT_PER_MINUTE` / `RATE_LIMIT_AUTH_PER_MINUTE` | `true` / `300` / `30` | Request rate limits for `/api/*`. |
| `TOTP_REQUIRED_ROLES` | empty | Roles forced to enable two-factor authentication (for example `admin`). |
| `CORS_ORIGINS` | `http://localhost:5173` | Allowed frontend origins, comma separated. |

Mail (SMTP) settings have no environment variables: configure them under
**Settings → Mail notifications**. The SMTP password is encrypted with `SECRET_KEY` before it
is stored and is never sent back to the browser.

## Security notes

- **Keep the PVE token privileges narrow.** A token with `--privsep 0` on `/` is root-equivalent
  for the API. Grant roles per path instead.
- **Backups are not configured by default.** The panel can protect existing backup files from
  deletion, but it does not schedule `vzdump` jobs for you — use Proxmox's own backup jobs.
- **HTTPS is expected in production.** Put the panel behind Nginx / Caddy, set `FORCE_HTTPS=true`
  and keep `FORWARDED_ALLOW_IPS` at your proxy's address.
- **Two-factor authentication** is available for every account and can be enforced by role.
- **Reset a guest's user password** uses one of three channels, all audited and behind a
  step-up confirmation:
  - the QEMU **guest agent** (instant, no reboot; falls back to running `chpasswd` inside the
    guest when the agent is too old to set passwords);
  - **cloud-init** (writes `cipassword`, regenerates the config drive, reboots — applies on the
    next boot when the guest is stopped);
  - for containers, **`pct exec … chpasswd` over SSH** on the host, using the credentials from
    **SSH → managed hosts**. Proxmox's API cannot execute commands inside a container, so this
    is the only channel; without managed-host credentials the dialog says so and points you at
    the container console. The password is piped through base64 to avoid any quoting issue.
- **Nothing runs on the guests by default.** The panel never enables automatic package upgrades
  in cloud-init unless you ask for it.

## Development and tests

```bash
# backend — unit and API tests (they create a separate <DB_NAME>_test database)
cd backend
../.venv/bin/python -m pytest

# frontend — type check, dependency graph check, production build
npm run verify
```

The backend suite covers configuration building, the API surface with RBAC and audit, firewall,
hardening, SSH security, port guarding, bulk operations, containers and the guest-password
channels. It needs no Proxmox host: the API layer is tested against a simulated Proxmox server.

## Proxmox VE compatibility

The panel speaks the Proxmox REST API and uses one code path for **8.x and 9.x** — no
version branches. Both are exercised against real clusters; a few fields are read
opportunistically (present → used, absent → fallback). The version string from `/version` is
only displayed. The one version-sensitive feature is the console: Proxmox's websocket endpoint
accepts only a `PVEAuthCookie`, not an API token, on both 8.x and 9.x.

## License

[Apache-2.0](LICENSE)

## Links

- Website and demo: <https://prox.yjscloud.com>
- Issues and feature requests: <https://github.com/yjscloud/ProxCenter/issues>
- Full documentation (Chinese): [README.md](README.md)
