# Running Metaval Foundry in VS Code — Step-by-Step

This project is now a single Node/Express app: `server.js` serves **both**
the API (`/api/...`) and the frontend (`Frontend.html`) on one port. You
only ever run one command, in one terminal.

Folder layout (what you should see in the VS Code Explorer):

```
metaval-foundry-backend/
├─ db/                    (postgres.js connection, schema.sql tables, migrate.js)
├─ node_modules/          (created by npm install — not shipped)
├─ .env.example
├─ .gitignore
├─ package.json
├─ package-lock.json
├─ README.md
├─ server.js
└─ Frontend.html
```

---

## 1. Install prerequisites (one-time, on this PC)

- Install **Node.js 18+** (20 LTS recommended) from https://nodejs.org
- Install **VS Code** from https://code.visualstudio.com
- Verify Node is installed: open any terminal and run:
  ```
  node -v
  npm -v
  ```
  Both should print a version number. If not, reinstall Node.js and restart
  your PC/terminal.

## 2. Open the project folder in VS Code

- Launch VS Code
- `File → Open Folder...`
- Select the `metaval-foundry-backend` folder (the one containing
  `server.js` and `Frontend.html` side by side)
- The Explorer panel on the left should now show the file list above

## 3. Open the integrated terminal

- Menu: `Terminal → New Terminal` (or press `` Ctrl+` ``)
- This opens a terminal **already pointed at the project folder** — you
  don't need to `cd` anywhere if you opened the correct folder in step 2.
- Confirm with:
  ```
  pwd
  ```
  (or on Windows PowerShell: `Get-Location`) — it should show the path to
  `metaval-foundry-backend`.

## 4. Install dependencies

In that same terminal:

```
npm install
```

This reads `package.json` / `package-lock.json` and creates the
`node_modules/` folder (express, cors, jsonwebtoken, bcryptjs, dotenv, pg).
You only need to do this once, or again after pulling new dependency
changes.

## 5. Create your `.env` file

Copy the example file to a real `.env` (this is what `server.js` actually
reads):

- **Windows PowerShell:**
  ```
  Copy-Item .env.example .env
  ```
- **macOS/Linux terminal:**
  ```
  cp .env.example .env
  ```

Open `.env` in VS Code and check the admin password line. If it contains a
`#`, it **must** be wrapped in quotes, or the value gets truncated at the
`#`:

```
ADMIN_PASSWORD="Singh@#302"
```

(The provided `.env.example` already has this fixed — just don't remove the
quotes if you change the password later.)

## 6. Start the app (the only command you need each time)

```
npm start
```

You should see something like:

```
Metaval Foundry server running at http://0.0.0.0:4000
Open the app:   http://localhost:4000/
API base:       http://localhost:4000/api
LAN app URL:    http://<YOUR-PC-IP>:4000/
LAN API base:   http://<YOUR-PC-IP>:4000/api
Database:       metaval_foundry @ 127.0.0.1:5432
```

This one terminal is now running the API **and** the frontend together.
Leave it running — closing the terminal, or pressing `Ctrl+C` in it, stops
the app.

## 7. Open the app in your browser

Go to:

```
http://localhost:4000/
```

Log in with the demo admin account:

- Username or email: `Jatin` or `jatin.singh@metaval.com`
- Password: `Singh@#302`

## 8. Using it from another PC on the same network (optional)

- On the host PC (the one running `npm start`), find its IPv4 address:
  - Windows: `ipconfig` → look for "IPv4 Address" (e.g. `192.168.1.25`)
  - macOS/Linux: `ifconfig` or `ip addr`
- On the other PC's browser, go to:
  ```
  http://192.168.1.25:4000/
  ```
  (replacing `192.168.1.25` with the host PC's actual IP). No extra config
  is needed — the frontend automatically talks to the API on that same
  address.
- Make sure Windows Firewall (or your OS firewall) allows inbound
  connections on port 4000 for Node.js, or the other PC won't be able to
  connect.

## 9. Everyday workflow after the first-time setup

Each time you want to work on/use the app, you only need:

```
npm start
```

(`npm install` is only needed again if `package.json` changes.)

## 10. Handy VS Code extras

- `npm run dev` uses `node --watch server.js` — the server auto-restarts
  when you edit `server.js`. Useful while developing; use `npm start` for
  a normal run.
- `npm run check` runs `node --check server.js` — a quick syntax check
  without starting the server.
- The **Run and Debug** panel (left sidebar, the play-with-bug icon) can
  also launch `server.js` with breakpoints if you create a launch
  configuration — for most day-to-day use, the integrated terminal with
  `npm start` is all you need.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `npm: command not found` | Node.js isn't installed or your terminal needs restarting after install. |
| `EADDRINUSE: address already in use :::4000` | Another `node server.js` is already running. Close that terminal, or find and stop the process, then retry. |
| Browser shows "This site can't be reached" at localhost:4000 | The server isn't running — check the terminal for errors, or you closed it. |
| Login fails with the demo password | Check `.env` — if `ADMIN_PASSWORD` has a `#` in it and isn't wrapped in quotes, it gets truncated. Fix and restart the server (the admin account is only created once — to reset it, run `DELETE FROM core.users WHERE employee_code='ADMIN-001';` in psql, then restart). |
| Changes to `Frontend.html` don't show up | Hard-refresh the browser (`Ctrl+Shift+R`) — it may be cached. |
| Another PC can't reach the app | Check firewall rules on the host PC for port 4000, and confirm both machines are on the same network/subnet. |
