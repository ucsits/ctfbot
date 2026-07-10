-- Migration 012: Add file support columns to documents table
-- Allows anchoring actual files (binary) alongside text documents.

ALTER TABLE documents ADD COLUMN filename TEXT;
ALTER TABLE documents ADD COLUMN file_size INTEGER;
ALTER TABLE documents ADD COLUMN file_data BLOB;
