# Metaval Foundry — Local/LAN Test

`server.js` now serves **both** the API and `Frontend.html`. One process, one
port, one terminal: run `npm start` and open the app in your browser — you
never need to open `Frontend.html` directly or run a second server.

## Requirements
- Node.js 18+ (20+ recommended)
- PostgreSQL 14+

## Install
Open PowerShell in this folder:

    npm install

## Configure
Copy `.env.example` to `.env` and fill in the `DB_*` values (see **Database** below).

Demo admin:
- Username: Pappu ke papa
- Email: Apni daal 
- Password: Teri Marzi

> **Important:** if you set `ADMIN_PASSWORD` yourself in `.env`, and it
> contains a `#`, wrap the whole value in quotes, e.g.
> `ADMIN_PASSWORD="Salary badha do"`. Without quotes, the `.env` loader treats
> everything after `#` as a comment and silently truncates the password.

Change the JWT secret and password before any real deployment.

## Start (single terminal — this is the only command you run)

    npm start

Then open the app in your browser:

    http://localhost:4000/

Health check:

    http://localhost:4000/api/health

LAN (another PC on the same network):

    http://YOUR-PC-IP:4000/

## How the frontend finds the backend

`Frontend.html` is served by this same Express server, so by default it talks
to the API on the same host and port it was loaded from
(`window.METAVAL_API_BASE || 'http://localhost:4000/api'`). You don't need to
configure anything for local or same-machine use.

If someone opens the app from another computer on the LAN using the host
PC's IP (e.g. `http://192.168.1.25:4000/`), it will automatically call the
API at `http://192.168.1.25:4000/api` too — no edits needed, because both are
served from the same address. You'd only ever need to set
`window.METAVAL_API_BASE` manually if you were hosting the HTML file
somewhere separate from this backend (not the setup here).

## Employee account creation

Admin calls:

    POST /api/employees

Example:

    {
      "name": "Priya Sharma",
      "email": "priya@metaval.com",
      "password": "StrongPassword123!",
      "department": "Melting Shop",
      "role": "operator"
    }

Supported roles:
employee
operator
melting_incharge
metallurgist
qa

## Chat

Public:
GET  /api/chat/messages?mode=public
POST /api/chat/messages

Private:
GET  /api/chat/messages?mode=private&peer=EMP-ID
POST /api/chat/messages

## Heat endpoints

POST   /api/heats
PUT    /api/heats/:id/targets
PUT    /api/heats/:id/charge-rows
POST   /api/heats/:id/oes
PATCH  /api/heats/:id/yield-loss
PUT    /api/heats/:id/residuals
GET    /api/heats/:id/status
GET    /api/heats/:id/cost
GET    /api/heats/:id/correction-plan
GET    /api/heats/:id/release-check
POST   /api/heats/:id/approvals
POST   /api/heats/:id/release

## Database (PostgreSQL)

All data now lives in PostgreSQL, in one database (`metaval_foundry`) with
three schemas:

    core      users, roles, departments, permissions, role_permissions,
              user_roles, messages (chat), audit_log
    casting   heats, chemistry, charge, oes, corrections, approvals, costing, history
    ingot     (same tables as casting, completely separate data)

A heat created with `calculator: "casting"` is stored in the `casting` schema
and gets a number like `CST-000001`; `calculator: "ingot"` goes to the `ingot`
schema and gets `ING-000001`. The prefix tells the server which schema to read.

### One-time setup

1. Install PostgreSQL 14+ and make sure the service is running.
2. Create the login + database (edit the password inside the file first!):

       psql -U postgres -f db/00_create_database.sql

3. Put the same values in `.env` (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`).
4. Create all tables (safe to re-run any time):

       npm run db:setup

5. `npm start` — the first start creates the admin account in `core.users`.

Where things are:

| What | File |
|------|------|
| Connection settings | `.env` -> read by `db/postgres.js` |
| Table definitions (edit here to add columns/tables) | `db/schema.sql` |
| Every query the API runs | `server.js` |

The old `data/metaval.json` file is no longer used.

## Important

This is a local/LAN test backend. It is not a production security architecture.
For production, use your approved database, HTTPS, proper secret management,
backups, rate limiting, enterprise identity and secure password policies.
