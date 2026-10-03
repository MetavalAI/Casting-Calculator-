-- =====================================================================
-- STEP 0 (run ONCE, as the PostgreSQL superuser "postgres")
--   psql -U postgres -f db/00_create_database.sql
-- Creates the application login + the database. Change the password!
-- The same values must go in your .env (DB_USER / DB_PASSWORD / DB_NAME).
-- =====================================================================
CREATE ROLE metaval_app LOGIN PASSWORD 'CHANGE_ME_STRONG_PASSWORD';
CREATE DATABASE metaval_foundry OWNER metaval_app ENCODING 'UTF8';
