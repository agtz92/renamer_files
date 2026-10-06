import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPlan } from '../src/plan.ts';
import { applyMoves, undoMoves } from '../src/apply.ts';
import type { Rule, ScanOptions } from '../src/types.ts';

const IGNORE = ['.DS_Store'];

const RULE: Rule = { mode: 'pattern', pattern: 'Episode #', template: 'S01E{#:02}{ext}' };
const OPTS: ScanOptions = { includeSubfolders: true, flatten: true, deleteEmptyDirs: true, extensions: [] };

async function tree(spec: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'renamer-test-'));
  for (const [rel, content] of Object.entries(spec)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return root;
}

async function listAll(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (e.isDirectory()) {
        out.push(rel + '/');
        await walk(abs);
      } else out.push(rel);
    }
  }
  await walk(root);
  return out.sort();
}

test('el plan aplana y renombra lo que coincide', async () => {
  const root = await tree({
    'Episode 1/[Grupo] Serie - Episode 1 [1080p].mkv': 'a',
    'Episode 2/[Grupo] Serie - Episode 2 [1080p].mkv': 'b',
    'Episode 2/subs/spanish.ass': 'c',
  });
  const plan = await buildPlan(root, RULE, OPTS, IGNORE);

  const byName = new Map(plan.items.map((i) => [i.relPath, i]));
  assert.equal(byName.get('Episode 1/[Grupo] Serie - Episode 1 [1080p].mkv')?.targetName, 'S01E01.mkv');
  assert.equal(byName.get('Episode 2/[Grupo] Serie - Episode 2 [1080p].mkv')?.targetName, 'S01E02.mkv');

  const sub = byName.get('Episode 2/subs/spanish.ass');
  assert.equal(sub?.status, 'nomatch');
  assert.equal(sub?.targetName, 'spanish.ass', 'lo que no coincide conserva su nombre');
  assert.equal(sub?.moves, true, 'pero si se mueve a la raiz');

  assert.equal(plan.counts.ok, 2);
  assert.equal(plan.counts.nomatch, 1);
  assert.equal(plan.emptyDirs.length, 3, 'las tres carpetas quedarian vacias');
});

test('una colision se resuelve con sufijo y se marca', async () => {
  const root = await tree({
    'Episode 2/Serie - Episode 2.mkv': 'a',
    'Episode 2/Serie - Episode 2 (v2).mkv': 'b',
  });
  const plan = await buildPlan(root, RULE, OPTS, IGNORE);
  const names = plan.items.map((i) => i.targetName).sort();
  assert.deepEqual(names, ['S01E02-2.mkv', 'S01E02.mkv']);
  assert.equal(plan.counts.collision, 1);
  assert.equal(plan.items.some((i) => i.note.includes('-2')), true);
});

test('un archivo que ya esta bien no genera movimiento', async () => {
  const root = await tree({ 'S01E05.mkv': 'a' });
  const plan = await buildPlan(root, { mode: 'auto', pattern: '', template: 'S{s:02}E{e:02}{ext}' }, OPTS, IGNORE);
  assert.equal(plan.items[0]?.status, 'unchanged');
  assert.equal(plan.items[0]?.selected, false);
  assert.equal(plan.counts.unchanged, 1);
});

test('un destino ocupado por un archivo que se queda tambien es colision', async () => {
  const root = await tree({
    'S01E01.mkv': 'ya existia',
    'Episode 1/Serie - Episode 1.mkv': 'nuevo',
  });
  // Sin subcarpetas el archivo de la raiz no entra al plan, pero ocupa el nombre.
  const plan = await buildPlan(root, RULE, { ...OPTS, includeSubfolders: true }, IGNORE);
  const nuevo = plan.items.find((i) => i.relPath.startsWith('Episode 1/'));
  assert.equal(nuevo?.targetName, 'S01E01-2.mkv');
});

test('aplicar deja el disco como decia el plan, y el undo lo regresa', async () => {
  const root = await tree({
    'Episode 1/Serie - Episode 1.mkv': 'a',
    'Episode 2/Serie - Episode 2.mkv': 'b',
    'Episode 2/subs/spanish.ass': 'c',
  });
  const before = await listAll(root);
  const plan = await buildPlan(root, RULE, OPTS, IGNORE);
  const moves = plan.items.filter((i) => i.selected).map((i) => ({ from: i.sourceAbs, to: i.targetAbs }));

  const res = await applyMoves(root, moves, { deleteEmptyDirs: true, emptyDirs: plan.emptyDirs });
  assert.equal(res.failures.length, 0);
  assert.equal(res.applied.length, 3);
  assert.deepEqual(await listAll(root), ['S01E01.mkv', 'S01E02.mkv', 'spanish.ass']);
  assert.equal(res.removedDirs.length, 3);
  assert.equal(await fs.readFile(path.join(root, 'S01E02.mkv'), 'utf8'), 'b');

  const undo = await undoMoves(root, res.applied);
  assert.equal(undo.failures.length, 0);
  assert.equal(undo.skipped.length, 0);
  assert.equal(undo.restored, 3);
  assert.deepEqual(await listAll(root), before, 'el arbol queda igual que antes');
});

test('un intercambio de nombres no pierde archivos', async () => {
  const root = await tree({ 'A.mkv': 'contenido-A', 'B.mkv': 'contenido-B' });
  const moves = [
    { from: path.join(root, 'A.mkv'), to: path.join(root, 'B.mkv') },
    { from: path.join(root, 'B.mkv'), to: path.join(root, 'A.mkv') },
  ];
  const res = await applyMoves(root, moves, { deleteEmptyDirs: false, emptyDirs: [] });
  assert.equal(res.failures.length, 0, 'el ciclo se resuelve con la fase temporal');
  assert.equal(await fs.readFile(path.join(root, 'B.mkv'), 'utf8'), 'contenido-A');
  assert.equal(await fs.readFile(path.join(root, 'A.mkv'), 'utf8'), 'contenido-B');
  assert.deepEqual(await listAll(root), ['A.mkv', 'B.mkv'], 'no quedan temporales');
});

test('el undo omite un archivo que ya no es el mismo', async () => {
  const root = await tree({ 'Episode 1/Serie - Episode 1.mkv': 'original' });
  const plan = await buildPlan(root, RULE, OPTS, IGNORE);
  const moves = plan.items.filter((i) => i.selected).map((i) => ({ from: i.sourceAbs, to: i.targetAbs }));
  const res = await applyMoves(root, moves, { deleteEmptyDirs: true, emptyDirs: plan.emptyDirs });

  // Alguien reemplaza el archivo despues de aplicar.
  await fs.rm(path.join(root, 'S01E01.mkv'));
  await fs.writeFile(path.join(root, 'S01E01.mkv'), 'otro archivo distinto');

  const undo = await undoMoves(root, res.applied);
  assert.equal(undo.restored, 0);
  assert.equal(undo.skipped.length, 1);
  assert.match(undo.skipped[0]!.reason, /otro archivo/i);
  assert.equal(await fs.readFile(path.join(root, 'S01E01.mkv'), 'utf8'), 'otro archivo distinto');
});

test('apply rechaza cualquier ruta fuera de la carpeta de trabajo', async () => {
  const root = await tree({ 'a.mkv': 'a' });
  const fuera = path.join(os.tmpdir(), 'renamer-escape.mkv');
  const res = await applyMoves(root, [{ from: path.join(root, 'a.mkv'), to: fuera }], {
    deleteEmptyDirs: false,
    emptyDirs: [],
  });
  assert.equal(res.applied.length, 0);
  assert.equal(res.failures.length, 1);
  assert.match(res.failures[0]!.error, /fuera/i);
  assert.deepEqual(await listAll(root), ['a.mkv']);
});

test('las extensiones filtran el escaneo', async () => {
  const root = await tree({
    'Episode 1/Serie - Episode 1.mkv': 'a',
    'Episode 1/folder.jpg': 'b',
  });
  const plan = await buildPlan(root, RULE, { ...OPTS, extensions: ['mkv'] }, IGNORE);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0]?.targetName, 'S01E01.mkv');
});

test('los archivos ocultos no entran al plan', async () => {
  const root = await tree({ 'Episode 1/Serie - Episode 1.mkv': 'a', 'Episode 1/.DS_Store': 'x' });
  const plan = await buildPlan(root, RULE, OPTS, IGNORE);
  assert.equal(plan.items.length, 1);
});
