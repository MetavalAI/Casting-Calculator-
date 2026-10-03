-- =====================================================================
-- METAVAL ERP DATABASE  (one database, three schemas)
--
--   metaval_foundry
--     ├─ core     users, roles, departments, permissions, user_roles,
--     │           role_permissions, messages (chat), audit_log
--     ├─ casting  heats, chemistry, charge, oes, corrections,
--     │           approvals, costing, history
--     └─ ingot    (same tables as casting, completely separate data)
--
-- Safe to run more than once (idempotent). Run with:  npm run db:setup
-- =====================================================================
BEGIN;

CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS casting;
CREATE SCHEMA IF NOT EXISTS ingot;

-- ---------- shared helper: keeps updated_at correct automatically ----------
CREATE OR REPLACE FUNCTION core.set_updated_at() RETURNS trigger AS $fn$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

-- =====================================================================
-- CORE SCHEMA
-- =====================================================================
CREATE TABLE IF NOT EXISTS core.roles (
  id          smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        text NOT NULL UNIQUE,          -- used by the code: 'admin', 'qa' ...
  name        text NOT NULL,
  description text
);

CREATE TABLE IF NOT EXISTS core.departments (
  id   int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS core.permissions (
  id          int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        text NOT NULL UNIQUE,          -- e.g. 'heat.release'
  description text
);

CREATE TABLE IF NOT EXISTS core.role_permissions (
  role_id       smallint NOT NULL REFERENCES core.roles(id)       ON DELETE CASCADE,
  permission_id int      NOT NULL REFERENCES core.permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE SEQUENCE IF NOT EXISTS core.employee_code_seq;

CREATE TABLE IF NOT EXISTS core.users (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- Employee ID (internal)
  employee_code text NOT NULL UNIQUE,                              -- HR code shown in the app: ADMIN-001, EMP-00002 ...
  name          text NOT NULL,                                     -- Full name
  email         text NOT NULL,                                     -- Login email
  password_hash text NOT NULL,                                     -- bcrypt hash, never the password
  role_id       smallint NOT NULL REFERENCES core.roles(id),       -- Primary role
  department_id int REFERENCES core.departments(id),               -- Primary department
  active        boolean NOT NULL DEFAULT true,                     -- Account status
  created_at    timestamptz NOT NULL DEFAULT now(),                -- Account creation
  updated_at    timestamptz NOT NULL DEFAULT now()                 -- Last modification
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uq ON core.users (lower(email));

-- extra roles a user may hold on top of users.role_id
CREATE TABLE IF NOT EXISTS core.user_roles (
  user_id bigint   NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  role_id smallint NOT NULL REFERENCES core.roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS core.messages (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mode         text   NOT NULL CHECK (mode IN ('public','private')),
  sender_id    bigint NOT NULL REFERENCES core.users(id),
  recipient_id bigint REFERENCES core.users(id),
  text         text   NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((mode = 'private') = (recipient_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS messages_mode_id_idx ON core.messages (mode, id DESC);
CREATE INDEX IF NOT EXISTS messages_pair_idx    ON core.messages (sender_id, recipient_id);

CREATE TABLE IF NOT EXISTS core.audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action     text NOT NULL,
  user_id    bigint REFERENCES core.users(id) ON DELETE SET NULL,
  user_name  text,
  details    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON core.audit_log (created_at DESC);

DROP TRIGGER IF EXISTS trg_users_updated_at ON core.users;
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON core.users
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- ---------- seed data: roles ----------
INSERT INTO core.roles (code, name, description) VALUES
  ('admin',            'Administrator',    'Full access; final heat release'),
  ('employee',         'Employee',         'Basic access'),
  ('operator',         'Operator',         'Furnace / melting operator approval'),
  ('melting_incharge', 'Melting In-charge','Melting shop in-charge approval'),
  ('metallurgist',     'Metallurgist',     'Metallurgy approval'),
  ('qa',               'QA',               'Quality assurance approval')
ON CONFLICT (code) DO NOTHING;

-- ---------- seed data: permissions (tables ready; app does not enforce them yet) ----------
INSERT INTO core.permissions (code, description) VALUES
  ('heat.create',     'Create a heat'),
  ('heat.edit_own',   'Edit heats you created'),
  ('heat.edit_any',   'Edit any heat'),
  ('heat.approve',    'Give a role approval on a heat'),
  ('heat.release',    'Final release of a heat'),
  ('employee.manage', 'Create / deactivate / delete employees'),
  ('audit.view',      'View the audit trail'),
  ('chat.use',        'Use public and private chat')
ON CONFLICT (code) DO NOTHING;

INSERT INTO core.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM core.roles r CROSS JOIN core.permissions p
WHERE r.code = 'admin'
ON CONFLICT DO NOTHING;

INSERT INTO core.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM core.roles r JOIN core.permissions p
  ON p.code IN ('heat.create','heat.edit_own','chat.use')
WHERE r.code <> 'admin'
ON CONFLICT DO NOTHING;

INSERT INTO core.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM core.roles r JOIN core.permissions p ON p.code = 'heat.approve'
WHERE r.code IN ('operator','melting_incharge','metallurgist','qa')
ON CONFLICT DO NOTHING;

-- =====================================================================
-- CASTING SCHEMA   (heat numbers look like CST-000001)
-- =====================================================================
CREATE SEQUENCE IF NOT EXISTS casting.heat_no_seq;

CREATE TABLE IF NOT EXISTS casting.heats (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  heat_no               text NOT NULL UNIQUE
                          DEFAULT ('CST-' || lpad(nextval('casting.heat_no_seq')::text, 6, '0')),
  grade_name            text NOT NULL DEFAULT '',
  status                text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','RELEASED')),
  data_confidence       text NOT NULL DEFAULT 'SERVER_STORED',
  charged_weight_kg     numeric(12,3),
  final_metal_weight_kg numeric(12,3),
  created_by            bigint NOT NULL REFERENCES core.users(id),
  released_by           bigint REFERENCES core.users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  released_at           timestamptz
);
CREATE INDEX IF NOT EXISTS casting_heats_created_by_idx ON casting.heats (created_by);

-- Target chemistry (kind='target') and residual limits/actuals (kind='residual')
CREATE TABLE IF NOT EXISTS casting.chemistry (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  heat_id    bigint NOT NULL REFERENCES casting.heats(id) ON DELETE CASCADE,
  kind       text   NOT NULL CHECK (kind IN ('target','residual')),
  element    text   NOT NULL,
  target_pct numeric(10,5),      -- used when kind = 'target'
  actual_pct numeric(10,5),      -- used when kind = 'residual'
  limit_pct  numeric(10,5),      -- used when kind = 'residual'
  UNIQUE (heat_id, kind, element)
);

-- Charge mix (scrap / raw material lines)
CREATE TABLE IF NOT EXISTS casting.charge (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  heat_id      bigint NOT NULL REFERENCES casting.heats(id) ON DELETE CASCADE,
  line_no      int    NOT NULL,
  scrap_name   text   NOT NULL DEFAULT '',
  qty_kg       numeric(12,3) NOT NULL DEFAULT 0,
  price_per_kg numeric(12,4),
  UNIQUE (heat_id, line_no)
);

-- OES spectrometer readings, stage oes1 / oes2
CREATE TABLE IF NOT EXISTS casting.oes (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  heat_id   bigint NOT NULL REFERENCES casting.heats(id) ON DELETE CASCADE,
  stage     text   NOT NULL CHECK (stage IN ('oes1','oes2')),
  element   text   NOT NULL,
  value_pct numeric(10,5),
  UNIQUE (heat_id, stage, element)
);

-- Correction plan lines (table ready; the app does not write here yet)
CREATE TABLE IF NOT EXISTS casting.corrections (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  heat_id    bigint NOT NULL REFERENCES casting.heats(id) ON DELETE CASCADE,
  element    text,
  action     text,
  material   text,
  qty_kg     numeric(12,3),
  note       text,
  created_by bigint REFERENCES core.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One approval per role per heat
CREATE TABLE IF NOT EXISTS casting.approvals (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  heat_id     bigint   NOT NULL REFERENCES casting.heats(id) ON DELETE CASCADE,
  role_id     smallint NOT NULL REFERENCES core.roles(id),
  approved_by bigint   NOT NULL REFERENCES core.users(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (heat_id, role_id)
);

-- Cost snapshot, written when a heat is released
CREATE TABLE IF NOT EXISTS casting.costing (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  heat_id              bigint NOT NULL REFERENCES casting.heats(id) ON DELETE CASCADE,
  raw_charge_cost      numeric(16,2) NOT NULL,
  charged_kg           numeric(12,3) NOT NULL,
  finished_weight_kg   numeric(12,3),
  finished_cost_per_kg numeric(14,4),
  currency             text NOT NULL DEFAULT 'INR',
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- Every change made to a heat (who, what, when)
CREATE TABLE IF NOT EXISTS casting.history (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  heat_id    bigint NOT NULL REFERENCES casting.heats(id),
  action     text   NOT NULL,
  user_id    bigint REFERENCES core.users(id) ON DELETE SET NULL,
  details    jsonb  NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS casting_history_heat_idx    ON casting.history (heat_id);
CREATE INDEX IF NOT EXISTS casting_history_created_idx ON casting.history (created_at DESC);

DROP TRIGGER IF EXISTS trg_casting_heats_updated_at ON casting.heats;
CREATE TRIGGER trg_casting_heats_updated_at BEFORE UPDATE ON casting.heats
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- =====================================================================
-- INGOT SCHEMA   (heat numbers look like ING-000001)
-- =====================================================================
CREATE SEQUENCE IF NOT EXISTS ingot.heat_no_seq;

CREATE TABLE IF NOT EXISTS ingot.heats (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  heat_no               text NOT NULL UNIQUE
                          DEFAULT ('ING-' || lpad(nextval('ingot.heat_no_seq')::text, 6, '0')),
  grade_name            text NOT NULL DEFAULT '',
  status                text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','RELEASED')),
  data_confidence       text NOT NULL DEFAULT 'SERVER_STORED',
  charged_weight_kg     numeric(12,3),
  final_metal_weight_kg numeric(12,3),
  created_by            bigint NOT NULL REFERENCES core.users(id),
  released_by           bigint REFERENCES core.users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  released_at           timestamptz
);
CREATE INDEX IF NOT EXISTS ingot_heats_created_by_idx ON ingot.heats (created_by);

-- Target chemistry (kind='target') and residual limits/actuals (kind='residual')
CREATE TABLE IF NOT EXISTS ingot.chemistry (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  heat_id    bigint NOT NULL REFERENCES ingot.heats(id) ON DELETE CASCADE,
  kind       text   NOT NULL CHECK (kind IN ('target','residual')),
  element    text   NOT NULL,
  target_pct numeric(10,5),      -- used when kind = 'target'
  actual_pct numeric(10,5),      -- used when kind = 'residual'
  limit_pct  numeric(10,5),      -- used when kind = 'residual'
  UNIQUE (heat_id, kind, element)
);

-- Charge mix (scrap / raw material lines)
CREATE TABLE IF NOT EXISTS ingot.charge (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  heat_id      bigint NOT NULL REFERENCES ingot.heats(id) ON DELETE CASCADE,
  line_no      int    NOT NULL,
  scrap_name   text   NOT NULL DEFAULT '',
  qty_kg       numeric(12,3) NOT NULL DEFAULT 0,
  price_per_kg numeric(12,4),
  UNIQUE (heat_id, line_no)
);

-- OES spectrometer readings, stage oes1 / oes2
CREATE TABLE IF NOT EXISTS ingot.oes (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  heat_id   bigint NOT NULL REFERENCES ingot.heats(id) ON DELETE CASCADE,
  stage     text   NOT NULL CHECK (stage IN ('oes1','oes2')),
  element   text   NOT NULL,
  value_pct numeric(10,5),
  UNIQUE (heat_id, stage, element)
);

-- Correction plan lines (table ready; the app does not write here yet)
CREATE TABLE IF NOT EXISTS ingot.corrections (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  heat_id    bigint NOT NULL REFERENCES ingot.heats(id) ON DELETE CASCADE,
  element    text,
  action     text,
  material   text,
  qty_kg     numeric(12,3),
  note       text,
  created_by bigint REFERENCES core.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One approval per role per heat
CREATE TABLE IF NOT EXISTS ingot.approvals (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  heat_id     bigint   NOT NULL REFERENCES ingot.heats(id) ON DELETE CASCADE,
  role_id     smallint NOT NULL REFERENCES core.roles(id),
  approved_by bigint   NOT NULL REFERENCES core.users(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (heat_id, role_id)
);

-- Cost snapshot, written when a heat is released
CREATE TABLE IF NOT EXISTS ingot.costing (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  heat_id              bigint NOT NULL REFERENCES ingot.heats(id) ON DELETE CASCADE,
  raw_charge_cost      numeric(16,2) NOT NULL,
  charged_kg           numeric(12,3) NOT NULL,
  finished_weight_kg   numeric(12,3),
  finished_cost_per_kg numeric(14,4),
  currency             text NOT NULL DEFAULT 'INR',
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- Every change made to a heat (who, what, when)
CREATE TABLE IF NOT EXISTS ingot.history (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  heat_id    bigint NOT NULL REFERENCES ingot.heats(id),
  action     text   NOT NULL,
  user_id    bigint REFERENCES core.users(id) ON DELETE SET NULL,
  details    jsonb  NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ingot_history_heat_idx    ON ingot.history (heat_id);
CREATE INDEX IF NOT EXISTS ingot_history_created_idx ON ingot.history (created_at DESC);

DROP TRIGGER IF EXISTS trg_ingot_heats_updated_at ON ingot.heats;
CREATE TRIGGER trg_ingot_heats_updated_at BEFORE UPDATE ON ingot.heats
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

ALTER TABLE casting.heats ADD COLUMN IF NOT EXISTS heat_info jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE ingot.heats   ADD COLUMN IF NOT EXISTS heat_info jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
