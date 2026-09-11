-- Migration 020: Add the CTFd api_token column to ctfs
--
-- api_token is the only ctfs column that lived solely in the inline
-- CREATE TABLE IF NOT EXISTS in src/database/index.js. Because that statement
-- is a no-op on any database where ctfs already exists, databases created
-- before the CTFd integration never gained the column, and createCTF (which
-- always binds @api_token) failed with "no such column: api_token".
--
-- The migration runner recovers gracefully when the column is already present
-- on a fresh database, so this is safe to re-run.

ALTER TABLE ctfs ADD COLUMN api_token TEXT;
