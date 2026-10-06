/**
 * Persistencia: historial de operaciones y reglas guardadas.
 * El historial es lo que hace posible el undo, asi que guarda el mapa completo
 * de movimientos con el inode de cada archivo, no solo un resumen.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { AppliedMove, Operation, Rule, ScanOptions } from './types.ts';

export interface SavedRule extends Rule {
  id: number;
  name: string;
}

export interface Db {
  recordOperation(input: {
    root: string;
    rule: Rule;
    options: ScanOptions;
    moves: AppliedMove[];
    removedDirs: string[];
    failures: { from: string; to: string; error: string }[];
  }): number;
  listOperations(limit: number): Operation[];
  getOperation(id: number): Operation | null;
  markUndone(id: number): void;
  listRules(): SavedRule[];
  saveRule(name: string, rule: Rule): SavedRule;
  deleteRule(id: number): void;
  recentRoots(limit: number): { root: string; at: string }[];
}

interface Row {
  id: number;
  root: string;
  created_at: string;
  rule_json: string;
  options_json: string;
  moves_json: string;
  removed_dirs_json: string;
  failures_json: string;
  undone_at: string | null;
}

function toOperation(row: Row): Operation {
  return {
    id: row.id,
    root: row.root,
    createdAt: row.created_at,
    rule: JSON.parse(row.rule_json) as Rule,
    options: JSON.parse(row.options_json) as ScanOptions,
    moves: JSON.parse(row.moves_json) as AppliedMove[],
    removedDirs: JSON.parse(row.removed_dirs_json) as string[],
    failures: JSON.parse(row.failures_json) as Operation['failures'],
    undoneAt: row.undone_at,
  };
}

export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'renamer.sqlite'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      root TEXT NOT NULL,
      created_at TEXT NOT NULL,
      rule_json TEXT NOT NULL,
      options_json TEXT NOT NULL,
      moves_json TEXT NOT NULL,
      removed_dirs_json TEXT NOT NULL,
      failures_json TEXT NOT NULL,
      undone_at TEXT
    );
    CREATE INDEX IF NOT EXISTS operations_created_at ON operations (created_at DESC);
    CREATE TABLE IF NOT EXISTS rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      mode TEXT NOT NULL,
      pattern TEXT NOT NULL,
      template TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  return {
    recordOperation(input) {
      const stmt = db.prepare(`
        INSERT INTO operations (root, created_at, rule_json, options_json, moves_json, removed_dirs_json, failures_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const info = stmt.run(
        input.root,
        new Date().toISOString(),
        JSON.stringify(input.rule),
        JSON.stringify(input.options),
        JSON.stringify(input.moves),
        JSON.stringify(input.removedDirs),
        JSON.stringify(input.failures),
      );
      return Number(info.lastInsertRowid);
    },
    listOperations(limit) {
      const rows = db
        .prepare('SELECT * FROM operations ORDER BY id DESC LIMIT ?')
        .all(limit) as Row[];
      return rows.map(toOperation);
    },
    getOperation(id) {
      const row = db.prepare('SELECT * FROM operations WHERE id = ?').get(id) as Row | undefined;
      return row ? toOperation(row) : null;
    },
    markUndone(id) {
      db.prepare('UPDATE operations SET undone_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    },
    listRules() {
      return db.prepare('SELECT id, name, mode, pattern, template FROM rules ORDER BY name').all() as SavedRule[];
    },
    saveRule(name, rule) {
      db.prepare(`
        INSERT INTO rules (name, mode, pattern, template, created_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET mode = excluded.mode, pattern = excluded.pattern, template = excluded.template
      `).run(name, rule.mode, rule.pattern, rule.template, new Date().toISOString());
      return db.prepare('SELECT id, name, mode, pattern, template FROM rules WHERE name = ?').get(name) as SavedRule;
    },
    deleteRule(id) {
      db.prepare('DELETE FROM rules WHERE id = ?').run(id);
    },
    recentRoots(limit) {
      return db
        .prepare('SELECT root, MAX(created_at) AS at FROM operations GROUP BY root ORDER BY at DESC LIMIT ?')
        .all(limit) as { root: string; at: string }[];
    },
  };
}
