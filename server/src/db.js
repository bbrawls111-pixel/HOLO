import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(config.storageDir, { recursive: true });
fs.mkdirSync(config.avatarDir, { recursive: true });

export const db = new DatabaseSync(config.dbFile);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  nickname TEXT NOT NULL,
  setup_done INTEGER NOT NULL DEFAULT 0,
  avatar_mime TEXT,
  avatar_version INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  user_id INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  file_id INTEGER,
  created_at INTEGER NOT NULL,
  edited_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);

CREATE TABLE IF NOT EXISTS folders (
  path TEXT PRIMARY KEY,
  created_by INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  folder TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_by INTEGER,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_files_path ON files(path) WHERE deleted = 0;

CREATE TABLE IF NOT EXISTS file_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id),
  version INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  user_id INTEGER,
  note TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (file_id, version)
);

CREATE TABLE IF NOT EXISTS file_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ops (
  month TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);
`);

// Начальные данные: каналы и базовая структура папок проекта.
const seedChannel = db.prepare('INSERT OR IGNORE INTO channels (id, name, position) VALUES (?, ?, ?)');
[['general', 'Общий', 0], ['dev', 'Разработка', 1], ['art', 'Арт и звук', 2], ['ideas', 'Идеи', 3]].forEach(
  ([id, name, pos]) => seedChannel.run(id, name, pos),
);

const seedFolder = db.prepare('INSERT OR IGNORE INTO folders (path, created_by, created_at) VALUES (?, NULL, ?)');
['assets', 'assets/images', 'assets/sounds', 'assets/fonts', 'data', 'scripts', 'docs'].forEach((p) =>
  seedFolder.run(p, Date.now()),
);

export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
