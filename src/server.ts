/**
 * Servidor Fastify. Escucha en la LAN sin login, como el resto del homelab,
 * asi que la unica defensa real es la lista de roots: cada ruta que llega de
 * la UI se resuelve y se valida contra ellas antes de tocar el disco.
 */
import Fastify from 'fastify';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { resolveInRoots, isInside, OutsideRootError } from './fsx/paths.ts';
import { listDirectories } from './fsx/scan.ts';
import { buildPlan } from './plan.ts';
import { applyMoves, undoMoves } from './apply.ts';
import type { Rule, ScanOptions } from './types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
const db = openDb(config.dataDir);

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 16 * 1024 * 1024 });

await app.register(fastifyStatic, {
  root: path.resolve(here, '..', 'public'),
  prefix: '/',
});

function parseRule(raw: unknown): Rule {
  const r = (raw ?? {}) as Partial<Rule>;
  const mode = r.mode === 'auto' || r.mode === 'pattern' || r.mode === 'regex' ? r.mode : 'auto';
  return {
    mode,
    pattern: typeof r.pattern === 'string' ? r.pattern : '',
    template: typeof r.template === 'string' && r.template.trim() !== '' ? r.template : 'S01E{#:02}{ext}',
  };
}

function parseOptions(raw: unknown): ScanOptions {
  const o = (raw ?? {}) as Partial<ScanOptions>;
  return {
    includeSubfolders: o.includeSubfolders !== false,
    flatten: o.flatten !== false,
    deleteEmptyDirs: o.deleteEmptyDirs !== false,
    extensions: Array.isArray(o.extensions) ? o.extensions.filter((e) => typeof e === 'string').slice(0, 40) : [],
  };
}

app.get('/health', async () => ({ ok: true, roots: config.roots.length }));

app.get('/api/roots', async () => ({
  roots: config.roots,
  recent: db.recentRoots(8),
}));

app.get('/api/browse', async (req, reply) => {
  const q = req.query as { path?: string };
  const target = q.path && q.path.trim() !== '' ? q.path : config.roots[0];
  if (!target) return reply.code(400).send({ error: 'No hay ninguna carpeta permitida disponible' });
  const dir = resolveInRoots(target, config.roots);
  const st = await fs.stat(dir);
  if (!st.isDirectory()) return reply.code(400).send({ error: 'Esa ruta no es una carpeta' });

  const dirs = await listDirectories(dir, config.ignoreNames);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const fileCount = entries.filter((e) => e.isFile() && !e.name.startsWith('.')).length;

  const parent = path.dirname(dir);
  const canGoUp = config.roots.some((r) => isInside(r, parent)) && parent !== dir;

  return { path: dir, parent: canGoUp ? parent : null, dirs, fileCount };
});

app.post('/api/plan', async (req) => {
  const body = req.body as { root?: string; rule?: unknown; options?: unknown };
  const root = resolveInRoots(String(body.root ?? ''), config.roots);
  const rule = parseRule(body.rule);
  const options = parseOptions(body.options);
  const plan = await buildPlan(root, rule, options, config.ignoreNames);
  return plan;
});

app.post('/api/apply', async (req, reply) => {
  const body = req.body as {
    root?: string;
    rule?: unknown;
    options?: unknown;
    moves?: { from?: string; to?: string }[];
    emptyDirs?: string[];
  };
  const root = resolveInRoots(String(body.root ?? ''), config.roots);
  const rule = parseRule(body.rule);
  const options = parseOptions(body.options);

  const raw = Array.isArray(body.moves) ? body.moves : [];
  if (raw.length === 0) return reply.code(400).send({ error: 'No hay nada que aplicar' });
  if (raw.length > 20000) return reply.code(400).send({ error: 'Demasiados archivos en una sola operacion' });

  // Cada ruta se revalida en el servidor: la UI no es la autoridad.
  const moves: { from: string; to: string }[] = [];
  for (const m of raw) {
    const from = path.resolve(String(m.from ?? ''));
    const to = path.resolve(String(m.to ?? ''));
    if (!isInside(root, from) || !isInside(root, to)) throw new OutsideRootError(`${from} -> ${to}`);
    if (path.basename(to).trim() === '') throw new Error('Un destino no tiene nombre');
    moves.push({ from, to });
  }

  const emptyDirs = (Array.isArray(body.emptyDirs) ? body.emptyDirs : [])
    .map((d) => path.resolve(String(d)))
    .filter((d) => isInside(root, d) && d !== root);

  const result = await applyMoves(root, moves, {
    deleteEmptyDirs: options.deleteEmptyDirs,
    emptyDirs,
  });

  const operationId = db.recordOperation({
    root,
    rule,
    options,
    moves: result.applied,
    removedDirs: result.removedDirs,
    failures: result.failures,
  });

  return { operationId, ...result };
});

app.post('/api/undo/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const op = db.getOperation(Number(id));
  if (!op) return reply.code(404).send({ error: 'Esa operacion no existe' });
  if (op.undoneAt) return reply.code(409).send({ error: 'Esa operacion ya se deshizo' });

  const root = resolveInRoots(op.root, config.roots);
  const result = await undoMoves(root, op.moves);
  if (result.restored > 0) db.markUndone(op.id);
  return { operationId: op.id, ...result };
});

app.get('/api/history', async (req) => {
  const q = req.query as { limit?: string };
  const limit = Math.min(Number(q.limit ?? 50) || 50, config.historyLimit);
  const ops = db.listOperations(limit);
  // El historial no necesita el mapa completo de movimientos en la lista.
  return {
    operations: ops.map((o) => ({
      id: o.id,
      root: o.root,
      createdAt: o.createdAt,
      rule: o.rule,
      moveCount: o.moves.length,
      removedDirCount: o.removedDirs.length,
      failureCount: o.failures.length,
      undoneAt: o.undoneAt,
    })),
  };
});

app.get('/api/history/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const op = db.getOperation(Number(id));
  if (!op) return reply.code(404).send({ error: 'Esa operacion no existe' });
  return op;
});

app.get('/api/rules', async () => ({ rules: db.listRules() }));

app.post('/api/rules', async (req, reply) => {
  const body = req.body as { name?: string; rule?: unknown };
  const name = String(body.name ?? '').trim();
  if (name === '') return reply.code(400).send({ error: 'La regla necesita un nombre' });
  return { rule: db.saveRule(name.slice(0, 80), parseRule(body.rule)) };
});

app.delete('/api/rules/:id', async (req) => {
  const { id } = req.params as { id: string };
  db.deleteRule(Number(id));
  return { ok: true };
});

app.setErrorHandler((err: FastifyError, _req: FastifyRequest, reply: FastifyReply) => {
  const status = err instanceof OutsideRootError ? 403 : (err.statusCode ?? 500);
  app.log.error({ err }, 'request fallida');
  reply.code(status).send({ error: err.message });
});

await app.listen({ port: config.port, host: config.host });
app.log.info(`renamer escuchando en http://${config.host}:${config.port} · roots: ${config.roots.join(', ')}`);
