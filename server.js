require("dotenv").config(); // must stay first: db/postgres.js reads DB_* from .env

const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");

const { pool, query, withTransaction, testPostgresConnection } = require("./db/postgres");

const app = express();
const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || "0.0.0.0";
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET must be configured in the environment.");
};

app.use(cors({ origin: true }));
app.use(express.json({ limit: "2mb" }));

/* ---------------- FRONTEND (served from this same process/port) ---------------- */
const FRONTEND_FILE = path.join(__dirname, "Frontend.html");

app.get(["/", "/app", "/index.html"], (req, res) => {
  if (!fs.existsSync(FRONTEND_FILE)) {
    return res
      .status(500)
      .send("Frontend.html not found next to server.js. Expected at: " + FRONTEND_FILE);
  }
  res.sendFile(FRONTEND_FILE);
});

/* ---------------- HELPERS ---------------- */

const now = () => new Date().toISOString();

// Express 4 does not catch errors thrown inside async handlers. Wrap every
// async route with wrap(...) so a database error becomes a clean 500 instead
// of crashing / hanging the request.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** "12.5" -> 12.5, "" / null / "abc" -> null */
function toNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ---- Which calculator lives in which PostgreSQL schema -------------------
   The schema name is ONLY ever taken from this fixed list (never from user
   input), which is what makes it safe to put it into SQL text below.       */
const CALCULATORS = {
  casting: { schema: "casting", prefix: "CST" },
  ingot: { schema: "ingot", prefix: "ING" },
};
const PREFIX_TO_SCHEMA = { CST: "casting", ING: "ingot" };
const PRODUCTION_SCHEMAS = ["casting", "ingot"];

/* ---- Users ---------------------------------------------------------------- */

// Users are returned with their primary role code + department name joined in.
const USER_SELECT = `
  SELECT u.id, u.employee_code, u.name, u.email, u.password_hash, u.active,
         u.created_at, r.code AS role, d.name AS department
  FROM core.users u
  JOIN core.roles r ON r.id = u.role_id
  LEFT JOIN core.departments d ON d.id = u.department_id`;

// The frontend sees the HR employee_code as the user "id" (e.g. ADMIN-001, EMP-00002).
function publicUser(u) {
  return {
    id: u.employee_code,
    employeeCode: u.employee_code,
    name: u.name,
    email: u.email,
    role: u.role,
    department: u.department || "",
    active: u.active !== false,
  };
}

async function rolesOf(userId, primaryRole) {
  const { rows } = await query(
    `SELECT r.code FROM core.user_roles ur JOIN core.roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
    [userId]
  );
  return [...new Set([primaryRole, ...rows.map((r) => r.code)])];
}

async function getOrCreateDepartment(client, name) {
  const clean = String(name || "").trim();
  if (!clean) return null;
  const { rows } = await client.query(
    `INSERT INTO core.departments (name) VALUES ($1)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [clean]
  );
  return rows[0].id;
}

function signToken(user) {
  return jwt.sign(
    { sub: String(user.id), role: user.role, email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: "12h" }
  );
}

/* ---- Auditing ---------------------------------------------------------------
   core.audit_log   -> logins, employees, chat, password changes
   <schema>.history -> everything that happens to a heat                       */

async function audit(action, user, details = {}, client = pool) {
  await client.query(
    `INSERT INTO core.audit_log (action, user_id, user_name, details) VALUES ($1, $2, $3, $4)`,
    [action, user?.id ?? null, user?.name ?? null, JSON.stringify(details)]
  );
}

async function heatHistory(client, schema, heatId, action, user, details = {}) {
  await client.query(
    `INSERT INTO ${schema}.history (heat_id, action, user_id, details) VALUES ($1, $2, $3, $4)`,
    [heatId, action, user?.id ?? null, JSON.stringify(details)]
  );
}

/* ---- Admin bootstrap ------------------------------------------------------- */

async function ensureAdmin() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  const adminName = process.env.ADMIN_NAME?.trim();
  const adminEmployeeCode = process.env.ADMIN_EMPLOYEE_CODE?.trim();

  if (!email) {
    throw new Error("ADMIN_EMAIL must be configured.");
  }

  if (!password) {
    throw new Error("ADMIN_PASSWORD must be configured.");
  }

  if (!adminName) {
    throw new Error("ADMIN_NAME must be configured.");
  }
  if (!adminEmployeeCode) {
    throw new Error("ADMIN_EMPLOYEE_CODE must be configured.");
  }

  const role = await query(
    `SELECT id FROM core.roles WHERE code = $1`,
    ["admin"]
  );

  if (!role.rows.length) {
    throw new Error("Admin role is not configured in core.roles.");
  }

  const deptId = await getOrCreateDepartment(pool, "IT / Engineering");
  const hash = await bcrypt.hash(password, 12);

  const [byEmail, byEmployeeCode] = await Promise.all([
    query(`SELECT * FROM core.users WHERE lower(email) = $1 LIMIT 1`, [email]),
    query(`SELECT * FROM core.users WHERE employee_code = $1 LIMIT 1`, [adminEmployeeCode]),
  ]);

  const existingEmailRecord = byEmail.rows[0];
  const existingCodeRecord = byEmployeeCode.rows[0];

  if (existingEmailRecord && existingCodeRecord && existingEmailRecord.id !== existingCodeRecord.id) {
    throw new Error(
      "Admin email and employee code already belong to different accounts. Check ADMIN_EMAIL and ADMIN_EMPLOYEE_CODE in .env."
    );
  }

  const existing = existingEmailRecord || existingCodeRecord;
  if (existing) {
    await query(
      `UPDATE core.users
       SET employee_code = $1,
           name = $2,
           email = $3,
           password_hash = $4,
           role_id = $5,
           department_id = $6,
           active = true
       WHERE id = $7`,
      [adminEmployeeCode, adminName, email, hash, role.rows[0].id, deptId, existing.id]
    );
    console.log(`Synced admin account ${email} in core.users`);
    return;
  }

  await withTransaction(async (client) => {
    const currentDeptId = await getOrCreateDepartment(client, "IT / Engineering");

    await client.query(
      `INSERT INTO core.users (employee_code, name, email, password_hash, role_id, department_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [adminEmployeeCode, adminName, email, hash, role.rows[0].id, currentDeptId]
    );
  });

  console.log(`Created admin account ${email} in core.users`);
}

/* ---- Auth middleware -------------------------------------------------------- */

const auth = wrap(async (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!token) return res.status(401).json({ error: "Authentication required." });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Invalid or expired access token." });
  }

  const { rows } = await query(`${USER_SELECT} WHERE u.id = $1 AND u.active = true`, [
    Number(payload.sub),
  ]);

  if (!rows.length) {
    return res.status(401).json({ error: "Account is inactive or no longer exists." });
  }

  req.user = rows[0];
  req.user.roles = await rolesOf(rows[0].id, rows[0].role);
  next();
});

function adminOnly(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required." });
  }
  next();
}

/* ---- Heat loading ------------------------------------------------------------ */

/** Heat numbers start with CST- (casting) or ING- (ingot); that tells us the schema. */
function schemaForHeatNo(heatNo) {
  return PREFIX_TO_SCHEMA[String(heatNo).split("-")[0].toUpperCase()] || null;
}

/** Loads a heat + all its child rows and rebuilds the object shape the API always returned. */
async function loadHeat(heatNo) {
  const schema = schemaForHeatNo(heatNo);
  if (!schema) return null;

  const head = await query(
    `SELECT h.*, u.employee_code AS created_by_code
     FROM ${schema}.heats h JOIN core.users u ON u.id = h.created_by
     WHERE h.heat_no = $1`,
    [heatNo]
  );
  if (!head.rows.length) return null;
  const h = head.rows[0];

  const [chem, charge, oes, appr] = await Promise.all([
    query(`SELECT kind, element, target_pct, actual_pct, limit_pct FROM ${schema}.chemistry WHERE heat_id = $1 ORDER BY id`, [h.id]),
    query(`SELECT scrap_name, qty_kg, price_per_kg FROM ${schema}.charge WHERE heat_id = $1 ORDER BY line_no`, [h.id]),
    query(`SELECT stage, element, value_pct FROM ${schema}.oes WHERE heat_id = $1 ORDER BY id`, [h.id]),
    query(
      `SELECT r.code AS role, u.employee_code AS by, u.name, a.approved_at AS at
       FROM ${schema}.approvals a
       JOIN core.roles r ON r.id = a.role_id
       JOIN core.users u ON u.id = a.approved_by
       WHERE a.heat_id = $1`,
      [h.id]
    ),
  ]);

  const targets = {};
  const residuals = [];
  for (const c of chem.rows) {
    if (c.kind === "target") targets[c.element] = c.target_pct;
    else residuals.push({ element: c.element, actualPct: c.actual_pct, limitPct: c.limit_pct });
  }

  const oes1 = {};
  const oes2 = {};
  for (const o of oes.rows) (o.stage === "oes1" ? oes1 : oes2)[o.element] = o.value_pct;

  const approvals = {};
  for (const a of appr.rows) approvals[a.role] = { by: a.by, name: a.name, at: a.at };

  return {
    schema,
    dbId: h.id,
    id: h.heat_no,
    gradeName: h.grade_name,
    createdAt: h.created_at,
    updatedAt: h.updated_at,
    heatInfo: h.heat_info,
    createdBy: h.created_by,
    status: h.status,
    dataConfidence: h.data_confidence,
    releasedAt: h.released_at,
    targets,
    chargeRows: charge.rows.map((r) => ({
      scrapName: r.scrap_name,
      qtyKg: r.qty_kg,
      pricePerKg: r.price_per_kg,
    })),
    oes1,
    oes2,
    yieldLoss: {
      chargedWeightKg: h.charged_weight_kg,
      finalMetalWeightKg: h.final_metal_weight_kg,
    },
    residuals,
    approvals,
  };
}

/** Route helper: loads the heat named in :id or sends 404. Returns null if it answered. */
async function getHeat(req, res) {
  const heat = await loadHeat(req.params.id);
  if (!heat) {
    res.status(404).json({ error: "Heat not found." });
    return null;
  }
  return heat;
}

function canEditHeat(req, heat) {
  if (req.user.role === "admin") return true;
  return heat.createdBy === req.user.id && heat.status !== "RELEASED";
}
const hasKeys = (o) => Object.keys(o || {}).length > 0;
const hasOes = (h) => hasKeys(h.oes1) || hasKeys(h.oes2);

function computeCost(heat) {
  let rawChargeCost = 0;
  let chargedKg = 0;

  for (const row of heat.chargeRows) {
    const qty = Number(row.qtyKg ?? 0);
    const price = Number(row.pricePerKg ?? 0);
    if (Number.isFinite(qty) && qty > 0) {
      chargedKg += qty;
      rawChargeCost += qty * (Number.isFinite(price) ? price : 0);
    }
  }

  const fw = Number(heat.yieldLoss?.finalMetalWeightKg);
  const finishedWeight = Number.isFinite(fw) ? fw : null;

  return {
    rawChargeCost,
    chargedKg,
    finishedWeightKg: finishedWeight,
    finishedCostPerKg: finishedWeight > 0 ? rawChargeCost / finishedWeight : null,
  };
}

const APPROVAL_ROLES = ["operator", "melting_incharge", "metallurgist", "qa"];

/* ---------------- HEALTH ---------------- */

app.get("/api/health", wrap(async (req, res) => {
  let db = false;
  try {
    await query("SELECT 1");
    db = true;
  } catch { /* reported below */ }

  res.status(db ? 200 : 503).json({
    ok: db,
    database: db ? "connected" : "unreachable",
    service: "metaval-foundry-backend",
    time: now(),
  });
}));

/* ---------------- AUTH ---------------- */
/* ---- login brute-force protection (in memory, per IP + username) ---- */
const loginFails = new Map(); // key -> { count, first }
const LOGIN_MAX_FAILS = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
function loginBlocked(key) {
  const e = loginFails.get(key);
  if (!e) return false;
  if (Date.now() - e.first > LOGIN_WINDOW_MS) { loginFails.delete(key); return false; }
  return e.count >= LOGIN_MAX_FAILS;
}
function loginFailed(key) {
  const e = loginFails.get(key);
  if (!e || Date.now() - e.first > LOGIN_WINDOW_MS) loginFails.set(key, { count: 1, first: Date.now() });
  else e.count += 1;
}
app.post("/api/auth/login", wrap(async (req, res) => {
  const emailOrName = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");

  if (!emailOrName || !password) {
    return res.status(400).json({ error: "Email/username and password are required." });
  }
  const failKey = req.ip + "|" + emailOrName;
  if (loginBlocked(failKey)) {
    return res.status(429).json({ error: "Too many failed sign-in attempts. Try again in 15 minutes." });
  }
  const { rows } = await query(
    `${USER_SELECT}
     WHERE u.active = true
       AND (lower(u.email) = $1 OR (r.code = 'admin' AND lower(u.name) = $1))`,
    [emailOrName]
  );
  const user = rows[0];

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    loginFailed(failKey);
    await audit("LOGIN_FAILED", null, { login: emailOrName, ip: req.ip });
    return res.status(401).json({ error: "Invalid credentials or inactive account." });
  }

  loginFails.delete(failKey);
  const token = signToken(user);
  await audit("LOGIN", user, { login: emailOrName });

  res.json({ accessToken: token, token, user: publicUser(user) });
}));

app.get("/api/me", auth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.post("/api/auth/change-password", auth, wrap(async (req, res) => {
  const password = String(req.body?.password || "");

  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  const hash = await bcrypt.hash(password, 12);
  await query(`UPDATE core.users SET password_hash = $1 WHERE id = $2`, [hash, req.user.id]);
  await audit("CHANGE_PASSWORD", req.user);

  res.json({ ok: true });
}));

/* ---------------- EMPLOYEES ---------------- */

app.get("/api/employees", auth, adminOnly, wrap(async (req, res) => {
  const { rows } = await query(`${USER_SELECT} WHERE r.code <> 'admin' ORDER BY u.id`);
  res.json(rows.map(publicUser));
}));

app.get("/api/chat/employees", auth, wrap(async (req, res) => {
  const { rows } = await query(
    `${USER_SELECT} WHERE u.id <> $1 AND u.active = true ORDER BY u.id`,
    [req.user.id]
  );
  res.json(rows.map(publicUser));
}));

app.post("/api/employees", auth, adminOnly, wrap(async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const department = String(req.body?.department || "").trim();
  const role = String(req.body?.role || "employee").trim();

  if (!name || !email || !password) {
    return res.status(400).json({ error: "Name, email and password are required." });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Enter a valid work email." });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  // Valid roles now come from the database (core.roles); admin can't be assigned here.
  const roleRow = await query(`SELECT id FROM core.roles WHERE code = $1 AND code <> 'admin'`, [role]);
  if (!roleRow.rows.length) {
    return res.status(400).json({ error: "Invalid employee role." });
  }

  const exists = await query(`SELECT 1 FROM core.users WHERE lower(email) = $1`, [email]);
  if (exists.rows.length) {
    return res.status(409).json({ error: "An account with this email already exists." });
  }

  const hash = await bcrypt.hash(password, 12);

  const employee = await withTransaction(async (client) => {
    const deptId = await getOrCreateDepartment(client, department);
    const seq = await client.query(`SELECT nextval('core.employee_code_seq') AS n`);
    const code = "EMP-" + String(seq.rows[0].n).padStart(5, "0");

    await client.query(
      `INSERT INTO core.users (employee_code, name, email, password_hash, role_id, department_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [code, name, email, hash, roleRow.rows[0].id, deptId]
    );
    const created = await client.query(`${USER_SELECT} WHERE u.employee_code = $1`, [code]);
    await audit("CREATE_EMPLOYEE", req.user, { employeeId: code, email, role }, client);
    return created.rows[0];
  });

  res.status(201).json(publicUser(employee));
}));

app.patch("/api/employees/:id", auth, adminOnly, wrap(async (req, res) => {
  const found = await query(`${USER_SELECT} WHERE u.employee_code = $1 AND r.code <> 'admin'`, [
    req.params.id,
  ]);
  if (!found.rows.length) {
    return res.status(404).json({ error: "Employee not found." });
  }
  const user = found.rows[0];

  const updated = await withTransaction(async (client) => {
    if (typeof req.body?.active === "boolean") {
      await client.query(`UPDATE core.users SET active = $1 WHERE id = $2`, [req.body.active, user.id]);
    }
    if (req.body?.department !== undefined) {
      const deptId = await getOrCreateDepartment(client, req.body.department);
      await client.query(`UPDATE core.users SET department_id = $1 WHERE id = $2`, [deptId, user.id]);
    }
    const fresh = await client.query(`${USER_SELECT} WHERE u.id = $1`, [user.id]);
    await audit(
      "UPDATE_EMPLOYEE",
      req.user,
      { employeeId: user.employee_code, active: fresh.rows[0].active },
      client
    );
    return fresh.rows[0];
  });

  res.json(publicUser(updated));
}));

app.delete("/api/employees/:id", auth, adminOnly, wrap(async (req, res) => {
  const found = await query(`${USER_SELECT} WHERE u.employee_code = $1 AND r.code <> 'admin'`, [
    req.params.id,
  ]);
  if (!found.rows.length) {
    return res.status(404).json({ error: "Employee not found." });
  }
  const user = found.rows[0];

  try {
    await query(`DELETE FROM core.users WHERE id = $1`, [user.id]);
  } catch (err) {
    // 23503 = foreign_key_violation: this person already owns heats / chat messages / approvals.
    if (err.code === "23503") {
      return res.status(409).json({
        error: "This employee has heats, approvals or chat messages on record and cannot be deleted. Deactivate the account instead.",
      });
    }
    throw err;
  }

  await audit("DELETE_EMPLOYEE", req.user, { employeeId: user.employee_code, email: user.email });
  res.json({ ok: true });
}));

/* ---------------- HEATS ---------------- */

app.post("/api/heats", auth, wrap(async (req, res) => {
  const calculator = String(req.body?.calculator || "casting").toLowerCase();
  const calc = CALCULATORS[calculator];
  if (!calc) {
    return res.status(400).json({ error: "calculator must be 'casting' or 'ingot'." });
  }

  const gradeName = String(req.body?.gradeName || "");

  const heatNo = await withTransaction(async (client) => {
    const ins = await client.query(
      `INSERT INTO ${calc.schema}.heats (grade_name, created_by) VALUES ($1, $2) RETURNING id, heat_no`,
      [gradeName, req.user.id]
    );
    await heatHistory(client, calc.schema, ins.rows[0].id, "CREATE_HEAT", req.user, { gradeName });
    return ins.rows[0].heat_no;
  });

  res.status(201).json({ heat_id: heatNo, heatId: heatNo });
}));

app.put("/api/heats/:id/targets", auth, wrap(async (req, res) => {
  const heat = await getHeat(req, res);
  if (!heat) return;
  if (!canEditHeat(req, heat)) {
    return res.status(403).json({ error: "You cannot edit this heat." });
  }

  const targets =
    req.body?.targets && typeof req.body.targets === "object" && !Array.isArray(req.body.targets)
      ? req.body.targets
      : {};

  await withTransaction(async (client) => {
    await client.query(`DELETE FROM ${heat.schema}.chemistry WHERE heat_id = $1 AND kind = 'target'`, [heat.dbId]);
    for (const [element, value] of Object.entries(targets)) {
      await client.query(
        `INSERT INTO ${heat.schema}.chemistry (heat_id, kind, element, target_pct) VALUES ($1, 'target', $2, $3)`,
        [heat.dbId, element, toNum(value)]
      );
    }
    await client.query(`UPDATE ${heat.schema}.heats SET updated_at = now() WHERE id = $1`, [heat.dbId]);
    await heatHistory(client, heat.schema, heat.dbId, "UPDATE_TARGETS", req.user, { from: heat.targets, to: targets });
  });

  const echoed = {};
  for (const [k, v] of Object.entries(targets)) echoed[k] = toNum(v);
  res.json({ ok: true, targets: echoed });
}));

app.put("/api/heats/:id/charge-rows", auth, wrap(async (req, res) => {
  const heat = await getHeat(req, res);
  if (!heat) return;
  if (!canEditHeat(req, heat)) {
    return res.status(403).json({ error: "You cannot edit this heat." });
  }

  const rows = (Array.isArray(req.body?.rows) ? req.body.rows : []).map((r) => ({
    scrapName: String(r?.scrapName ?? r?.scrap ?? r?.name ?? ""),
    qtyKg: toNum(r?.qtyKg ?? r?.qty) ?? 0,
    pricePerKg: toNum(r?.pricePerKg ?? r?.costPerKg),
  }));

  await withTransaction(async (client) => {
    await client.query(`DELETE FROM ${heat.schema}.charge WHERE heat_id = $1`, [heat.dbId]);
    let line = 1;
    for (const r of rows) {
      await client.query(
        `INSERT INTO ${heat.schema}.charge (heat_id, line_no, scrap_name, qty_kg, price_per_kg)
         VALUES ($1, $2, $3, $4, $5)`,
        [heat.dbId, line++, r.scrapName, r.qtyKg, r.pricePerKg]
      );
    }
    await client.query(`UPDATE ${heat.schema}.heats SET updated_at = now() WHERE id = $1`, [heat.dbId]);
    await heatHistory(client, heat.schema, heat.dbId, "UPDATE_CHARGE_ROWS", req.user, { lines: rows.length, from: heat.chargeRows, to: rows });
  });

  res.json({ ok: true, rows });
}));

app.post("/api/heats/:id/oes", auth, wrap(async (req, res) => {
  const heat = await getHeat(req, res);
  if (!heat) return;
  if (!canEditHeat(req, heat)) {
    return res.status(403).json({ error: "You cannot edit this heat." });
  }

  const stage = String(req.body?.stage || "").toLowerCase();
  if (stage !== "oes1" && stage !== "oes2") {
    return res.status(400).json({ error: "stage must be oes1 or oes2." });
  }
  const readings =
    req.body?.readings && typeof req.body.readings === "object" && !Array.isArray(req.body.readings)
      ? req.body.readings
      : {};

  await withTransaction(async (client) => {
    await client.query(`DELETE FROM ${heat.schema}.oes WHERE heat_id = $1 AND stage = $2`, [heat.dbId, stage]);
    for (const [element, value] of Object.entries(readings)) {
      await client.query(
        `INSERT INTO ${heat.schema}.oes (heat_id, stage, element, value_pct) VALUES ($1, $2, $3, $4)`,
        [heat.dbId, stage, element, toNum(value)]
      );
    }
    await client.query(`UPDATE ${heat.schema}.heats SET updated_at = now() WHERE id = $1`, [heat.dbId]);
    await heatHistory(client, heat.schema, heat.dbId, "UPDATE_OES", req.user, { stage, from: stage === "oes1" ? heat.oes1 : heat.oes2, to: readings });
  });

  res.json({ ok: true, stage, readings });
}));

app.patch("/api/heats/:id/yield-loss", auth, wrap(async (req, res) => {
  const heat = await getHeat(req, res);
  if (!heat) return;
  if (!canEditHeat(req, heat)) {
    return res.status(403).json({ error: "You cannot edit this heat." });
  }

  const yieldLoss = {
    chargedWeightKg: toNum(req.body?.chargedWeightKg),
    finalMetalWeightKg: toNum(req.body?.finalMetalWeightKg),
  };

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE ${heat.schema}.heats SET charged_weight_kg = $1, final_metal_weight_kg = $2, updated_at = now() WHERE id = $3`,
      [yieldLoss.chargedWeightKg, yieldLoss.finalMetalWeightKg, heat.dbId]
    );
    await heatHistory(client, heat.schema, heat.dbId, "UPDATE_YIELD_LOSS", req.user, { from: heat.yieldLoss, to: yieldLoss });
  });

  res.json({ ok: true, yieldLoss });
}));

app.put("/api/heats/:id/residuals", auth, wrap(async (req, res) => {
  const heat = await getHeat(req, res);
  if (!heat) return;
  if (!canEditHeat(req, heat)) {
    return res.status(403).json({ error: "You cannot edit this heat." });
  }

  const residuals = (Array.isArray(req.body?.residuals) ? req.body.residuals : [])
    .filter((r) => r && r.element)
    .map((r) => ({
      element: String(r.element),
      actualPct: toNum(r.actualPct),
      limitPct: toNum(r.limitPct),
    }));

  await withTransaction(async (client) => {
    await client.query(`DELETE FROM ${heat.schema}.chemistry WHERE heat_id = $1 AND kind = 'residual'`, [heat.dbId]);
    for (const r of residuals) {
      await client.query(
        `INSERT INTO ${heat.schema}.chemistry (heat_id, kind, element, actual_pct, limit_pct)
         VALUES ($1, 'residual', $2, $3, $4)
         ON CONFLICT (heat_id, kind, element) DO UPDATE
           SET actual_pct = EXCLUDED.actual_pct, limit_pct = EXCLUDED.limit_pct`,
        [heat.dbId, r.element, r.actualPct, r.limitPct]
      );
    }
    await client.query(`UPDATE ${heat.schema}.heats SET updated_at = now() WHERE id = $1`, [heat.dbId]);
    await heatHistory(client, heat.schema, heat.dbId, "UPDATE_RESIDUALS", req.user, { from: heat.residuals, to: residuals });
  });

  res.json({ ok: true, residuals });
}));
/* ---------------- HISTORY PAGE ---------------- */

// 1) All heats (casting + ingot), newest first. Any logged-in user.
app.get("/api/heats", auth, wrap(async (req, res) => {
  const parts = PRODUCTION_SCHEMAS.map((s) => `
    SELECT '${s}' AS calculator, h.heat_no, h.grade_name, h.status, h.data_confidence,
           h.charged_weight_kg, h.final_metal_weight_kg,
           h.created_at, h.updated_at, h.released_at,
           cu.employee_code AS created_by_code, cu.name AS created_by_name,
           ru.name AS released_by_name,
           (SELECT count(*) FROM ${s}.approvals a WHERE a.heat_id = h.id)::int AS approval_count,
           c.raw_charge_cost, c.finished_cost_per_kg
    FROM ${s}.heats h
    JOIN core.users cu ON cu.id = h.created_by
    LEFT JOIN core.users ru ON ru.id = h.released_by
    LEFT JOIN ${s}.costing c ON c.heat_id = h.id`);

  const { rows } = await query(
    `SELECT * FROM (${parts.join(" UNION ALL ")}) t ORDER BY created_at DESC LIMIT 1000`
  );
  res.json(rows);
}));

// 2) One heat in full + its activity timeline. Any logged-in user.
app.get("/api/heats/:id", auth, wrap(async (req, res) => {
  const heat = await getHeat(req, res);
  if (!heat) return;

  const [hist, cost, who] = await Promise.all([
    query(
      `SELECT h.id, h.action, h.details, h.created_at, u.employee_code, u.name
       FROM ${heat.schema}.history h LEFT JOIN core.users u ON u.id = h.user_id
       WHERE h.heat_id = $1 ORDER BY h.id DESC`, [heat.dbId]),
    query(
      `SELECT raw_charge_cost, charged_kg, finished_weight_kg, finished_cost_per_kg, currency, created_at
       FROM ${heat.schema}.costing WHERE heat_id = $1 ORDER BY id DESC LIMIT 1`, [heat.dbId]),
    query(
      `SELECT cu.name AS created_by_name, cu.employee_code AS created_by_code, ru.name AS released_by_name
       FROM ${heat.schema}.heats h
       JOIN core.users cu ON cu.id = h.created_by
       LEFT JOIN core.users ru ON ru.id = h.released_by
       WHERE h.id = $1`, [heat.dbId]),
  ]);

  const { schema, dbId, ...publicHeat } = heat;
  res.json({
    ...publicHeat,
    calculator: schema,
    ...who.rows[0],
    costSnapshot: cost.rows[0] || null,
    history: hist.rows,
  });
}));

// 3) Save extra heat details (furnace, operator, customer ...). Owner or admin.
app.put("/api/heats/:id/info", auth, wrap(async (req, res) => {
  const heat = await getHeat(req, res);
  if (!heat) return;
  if (!canEditHeat(req, heat)) {
    return res.status(403).json({ error: "You cannot edit this heat." });
  }

  const info =
    req.body?.info && typeof req.body.info === "object" && !Array.isArray(req.body.info)
      ? req.body.info
      : {};

  await withTransaction(async (client) => {
    await client.query(`UPDATE ${heat.schema}.heats SET heat_info = $1 WHERE id = $2`, [
      JSON.stringify(info),
      heat.dbId,
    ]);
    await heatHistory(client, heat.schema, heat.dbId, "UPDATE_INFO", req.user);
  });
  res.json({ ok: true });
}));

// 4) Admin-only: edit the heat header (grade name).
app.patch("/api/heats/:id", auth, adminOnly, wrap(async (req, res) => {
  const heat = await getHeat(req, res);
  if (!heat) return;

  const gradeName = String(req.body?.gradeName || "").trim();
  if (!gradeName) return res.status(400).json({ error: "gradeName is required." });

  await withTransaction(async (client) => {
    await client.query(`UPDATE ${heat.schema}.heats SET grade_name = $1 WHERE id = $2`, [
      gradeName,
      heat.dbId,
    ]);
    await heatHistory(client, heat.schema, heat.dbId, "ADMIN_EDIT_HEAT", req.user, {
      field: "gradeName",
      from: heat.gradeName,
      to: gradeName,
    });
  });
  res.json({ ok: true });
}));

/* ---------------- SERVER CALCULATIONS ---------------- */

app.get("/api/heats/:id/status", auth, wrap(async (req, res) => {
  const heat = await getHeat(req, res);
  if (!heat) return;

  res.json({
    heatId: heat.id,
    status: heat.status,
    dataConfidence: heat.dataConfidence,
    hasTargets: hasKeys(heat.targets),
    hasChargeRows: heat.chargeRows.length > 0,
    hasOes: hasOes(heat),
    approvals: heat.approvals,
  });
}));

app.get("/api/heats/:id/cost", auth, wrap(async (req, res) => {
  const heat = await getHeat(req, res);
  if (!heat) return;

  res.json({
    ...computeCost(heat),
    currency: "INR",
    note: "Only prices explicitly supplied in charge rows are used; no material price is invented.",
  });
}));

app.get("/api/heats/:id/correction-plan", auth, wrap(async (req, res) => {
  const heat = await getHeat(req, res);
  if (!heat) return;

  const reasons = [];
  if (!hasKeys(heat.targets)) reasons.push("Target chemistry has not been stored.");
  if (!hasOes(heat)) reasons.push("OES readings have not been stored.");

  res.json({ heatId: heat.id, items: [], ready: reasons.length === 0, reasons });
}));

app.get("/api/heats/:id/release-check", auth, wrap(async (req, res) => {
  const heat = await getHeat(req, res);
  if (!heat) return;

  const reasons = [];
  if (!hasKeys(heat.targets)) reasons.push("Target chemistry is missing.");
  if (!hasOes(heat)) reasons.push("OES analysis is missing.");
  if (!heat.chargeRows.length) reasons.push("Charge mix is missing.");
  for (const role of APPROVAL_ROLES) {
    if (!heat.approvals[role]) reasons.push(`${role} approval is missing.`);
  }
  if (heat.status === "RELEASED") reasons.length = 0;

  res.json({
    heatId: heat.id,
    ready: reasons.length === 0,
    status: heat.status,
    reasons,
    approvals: heat.approvals,
  });
}));

app.post("/api/heats/:id/approvals", auth, wrap(async (req, res) => {
  const heat = await getHeat(req, res);
  if (!heat) return;

  const role = String(req.body?.role || "");
  if (!APPROVAL_ROLES.includes(role)) {
    return res.status(400).json({ error: "Invalid approval role." });
  }

  // admin, or anyone who holds that role (primary role in core.users, or extra roles in core.user_roles)
  if (req.user.role !== "admin" && !req.user.roles.includes(role)) {
    return res.status(403).json({ error: `Only ${role} or admin can approve.` });
  }

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO ${heat.schema}.approvals (heat_id, role_id, approved_by)
       SELECT $1, r.id, $3 FROM core.roles r WHERE r.code = $2
       ON CONFLICT (heat_id, role_id) DO UPDATE SET approved_by = EXCLUDED.approved_by, approved_at = now()`,
      [heat.dbId, role, req.user.id]
    );
    await client.query(`UPDATE ${heat.schema}.heats SET updated_at = now() WHERE id = $1`, [heat.dbId]);
    await heatHistory(client, heat.schema, heat.dbId, "HEAT_APPROVAL", req.user, { role });
  });

  const fresh = await loadHeat(heat.id);
  res.json({ ok: true, approvals: fresh.approvals });
}));

app.post("/api/heats/:id/release", auth, wrap(async (req, res) => {
  const heat = await getHeat(req, res);
  if (!heat) return;

  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required for final release." });
  }

  const missing = [];
  for (const role of APPROVAL_ROLES) {
    if (!heat.approvals[role]) missing.push(role);
  }
  if (!hasKeys(heat.targets)) missing.push("target-chemistry");
  if (!hasOes(heat)) missing.push("oes");
  if (!heat.chargeRows.length) missing.push("charge-mix");

  if (missing.length) {
    return res.status(409).json({ error: "Heat is not ready for release.", reasons: missing });
  }

  // Already released: answer idempotently without touching the record again.
  if (heat.status === "RELEASED") {
    return res.json({ ok: true, heatId: heat.id, status: heat.status, releasedAt: heat.releasedAt });
  }

  const cost = computeCost(heat);

  const releasedAt = await withTransaction(async (client) => {
    const upd = await client.query(
      `UPDATE ${heat.schema}.heats
       SET status = 'RELEASED', released_at = now(), released_by = $2
       WHERE id = $1 AND status <> 'RELEASED'
       RETURNING released_at`,
      [heat.dbId, req.user.id]
    );
    // Freeze a cost snapshot at the moment of release (skipped if someone else released it first).
    if (upd.rows.length) {
      await client.query(
        `INSERT INTO ${heat.schema}.costing
           (heat_id, raw_charge_cost, charged_kg, finished_weight_kg, finished_cost_per_kg)
         VALUES ($1, $2, $3, $4, $5)`,
        [heat.dbId, cost.rawChargeCost, cost.chargedKg, cost.finishedWeightKg, cost.finishedCostPerKg]
      );
      await heatHistory(client, heat.schema, heat.dbId, "HEAT_RELEASE", req.user);
    }
    return upd.rows[0]?.released_at ?? heat.releasedAt;
  });

  res.json({ ok: true, heatId: heat.id, status: "RELEASED", releasedAt });
}));

/* ---------------- CHAT ---------------- */

const MESSAGE_SELECT = `
  SELECT m.id, s.employee_code AS sender_id, s.name AS sender_name,
         r.employee_code AS recipient_id, m.text, m.mode, m.created_at
  FROM core.messages m
  JOIN core.users s ON s.id = m.sender_id
  LEFT JOIN core.users r ON r.id = m.recipient_id`;

const messageOut = (m) => ({
  id: String(m.id),
  sender_id: m.sender_id,
  sender_name: m.sender_name,
  recipient_id: m.recipient_id || null,
  text: m.text,
  mode: m.mode,
  created_at: m.created_at,
});

app.get("/api/chat/messages", auth, wrap(async (req, res) => {
  const mode = String(req.query.mode || "public");
  const peer = String(req.query.peer || req.query.peerId || "");

  let result;

  if (mode === "private") {
    if (!peer) {
      return res.status(400).json({ error: "peer is required for private chat." });
    }
    result = await query(
      `${MESSAGE_SELECT}
       WHERE m.mode = 'private'
         AND ((m.sender_id = $1 AND r.employee_code = $2)
           OR (s.employee_code = $2 AND m.recipient_id = $1))
       ORDER BY m.id DESC LIMIT 200`,
      [req.user.id, peer]
    );
  } else {
    result = await query(`${MESSAGE_SELECT} WHERE m.mode = 'public' ORDER BY m.id DESC LIMIT 200`);
  }

  // newest-200 fetched, returned oldest -> newest like before
  res.json(result.rows.reverse().map(messageOut));
}));

app.post("/api/chat/messages", auth, wrap(async (req, res) => {
  const mode = String(req.body?.mode || "public");
  const text = String(req.body?.text || "").trim();
  const recipientCode = req.body?.recipientId ? String(req.body.recipientId) : null;

  if (!text) return res.status(400).json({ error: "Message text is required." });
  if (text.length > 4000) return res.status(400).json({ error: "Message is too long." });
  if (!["public", "private"].includes(mode)) {
    return res.status(400).json({ error: "Invalid chat mode." });
  }

  let recipientDbId = null;

  if (mode === "private") {
    if (!recipientCode) {
      return res.status(400).json({ error: "Choose an employee for private chat." });
    }
    const rec = await query(
      `SELECT id FROM core.users WHERE employee_code = $1 AND active = true`,
      [recipientCode]
    );
    if (!rec.rows.length) {
      return res.status(404).json({ error: "Recipient not found." });
    }
    recipientDbId = rec.rows[0].id;
  }

  const message = await withTransaction(async (client) => {
    const ins = await client.query(
      `INSERT INTO core.messages (mode, sender_id, recipient_id, text) VALUES ($1, $2, $3, $4) RETURNING id`,
      [mode, req.user.id, recipientDbId, text]
    );
    await audit(
      "CHAT_MESSAGE",
      req.user,
      { messageId: ins.rows[0].id, mode, recipientId: recipientCode },
      client
    );
    const out = await client.query(`${MESSAGE_SELECT} WHERE m.id = $1`, [ins.rows[0].id]);
    return out.rows[0];
  });

  res.status(201).json(messageOut(message));
}));

/* ---------------- AUDIT ---------------- */

// One combined trail: core.audit_log + casting.history + ingot.history, newest first.
app.get("/api/audit", auth, adminOnly, wrap(async (req, res) => {
  const heatParts = PRODUCTION_SCHEMAS.map(
    (s) => `
    SELECT '${s}-' || h.id AS id, h.action, u.employee_code AS user_id, u.name AS user_name,
           h.created_at AS at, h.details || jsonb_build_object('heatId', ht.heat_no) AS details
    FROM ${s}.history h
    JOIN ${s}.heats ht ON ht.id = h.heat_id
    LEFT JOIN core.users u ON u.id = h.user_id`
  );

  const { rows } = await query(
    `SELECT * FROM (
       SELECT 'core-' || a.id AS id, a.action, u.employee_code AS user_id, a.user_name,
              a.created_at AS at, a.details
       FROM core.audit_log a LEFT JOIN core.users u ON u.id = a.user_id
       UNION ALL ${heatParts.join(" UNION ALL ")}
     ) t ORDER BY at DESC LIMIT 500`
  );

  res.json(
    rows.map((r) => ({
      id: r.id,
      action: r.action,
      userId: r.user_id,
      userName: r.user_name,
      at: r.at,
      details: r.details,
    }))
  );
}));

/* ---------------- ERRORS ---------------- */

app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found.", path: req.path });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error." });
});

/* ---------------- START ---------------- */

async function start() {
  try {
    await testPostgresConnection();
    await query("SELECT 1 FROM core.users LIMIT 1"); // fails if the tables were never created
  } catch (err) {
    console.error("\nCannot start: PostgreSQL is not ready.\n  " + err.message);
    if (err.code === "42P01") {
      console.error("  -> Tables are missing. Run:  npm run db:setup");
    } else if (err.code === "28P01") {
      console.error("  -> Wrong DB_USER / DB_PASSWORD in .env");
    } else if (err.code === "3D000") {
      console.error("  -> Database does not exist. Run db/00_create_database.sql first.");
    } else if (err.code === "ECONNREFUSED") {
      console.error("  -> PostgreSQL is not running, or DB_HOST / DB_PORT in .env is wrong.");
    }
    process.exit(1);
  }

  await ensureAdmin();

  const server = app.listen(PORT, HOST, () => {
    console.log(`Metaval Foundry server running at http://${HOST}:${PORT}`);
    console.log(`Open the app:   http://localhost:${PORT}/`);
    console.log(`API base:       http://localhost:${PORT}/api`);
    console.log(`LAN app URL:    http://<YOUR-PC-IP>:${PORT}/`);
    console.log(`LAN API base:   http://<YOUR-PC-IP>:${PORT}/api`);
    console.log(`Database:       ${process.env.DB_NAME || "metaval_foundry"} @ ${process.env.DB_HOST || "127.0.0.1"}:${process.env.DB_PORT || 5432}`);
  });

  const shutdown = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start();