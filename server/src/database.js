import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export function database(directory) {
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, "canvas.sqlite"));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, displayName TEXT NOT NULL,
      password TEXT NOT NULL, admin INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, title TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS members (projectId TEXT NOT NULL REFERENCES projects(id), userId TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(projectId,userId));
    CREATE TABLE IF NOT EXISTS canvases (
      id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), ownerId TEXT NOT NULL REFERENCES users(id),
      title TEXT NOT NULL, content TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      publishedId TEXT, deleted INTEGER NOT NULL DEFAULT 0, sourceId TEXT, sourceVersion TEXT,
      kind TEXT NOT NULL DEFAULT 'canvas', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY, canvasId TEXT NOT NULL REFERENCES canvases(id), title TEXT NOT NULL, content TEXT NOT NULL, createdAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS canvas_numbers (number INTEGER PRIMARY KEY AUTOINCREMENT, canvasId TEXT NOT NULL UNIQUE REFERENCES canvases(id));
    CREATE TRIGGER IF NOT EXISTS assign_canvas_number AFTER INSERT ON canvases
      BEGIN INSERT INTO canvas_numbers(canvasId) VALUES(NEW.id); END;
    INSERT INTO canvas_numbers(canvasId) SELECT id FROM canvases
      WHERE NOT EXISTS (SELECT 1 FROM canvas_numbers WHERE canvasId=canvases.id) ORDER BY createdAt,id;
    CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, ownerId TEXT NOT NULL REFERENCES users(id), mime TEXT NOT NULL, bytes INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS file_refs (fileId TEXT NOT NULL REFERENCES files(id), canvasId TEXT NOT NULL REFERENCES canvases(id), versionId TEXT NOT NULL DEFAULT '', PRIMARY KEY(fileId,canvasId,versionId));
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, createdAt TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS canvas_project ON canvases(projectId,ownerId);
    CREATE INDEX IF NOT EXISTS refs_canvas ON file_refs(canvasId,versionId);
  `);
  return db;
}

export function transaction(db, action) {
  db.exec("BEGIN IMMEDIATE");
  try { const result = action(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
