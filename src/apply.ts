/**
 * Ejecucion del plan y deshacer.
 *
 * El apply va en dos fases (origen -> temporal -> destino) por una razon
 * concreta: un plan puede pedir A->B y B->A, y hacerlo directo pierde un
 * archivo. Con dos fases cualquier permutacion es segura, y el costo es un
 * rename extra, que en el mismo volumen es gratis.
 *
 * El undo no confia en los nombres: guarda el inode de cada archivo al
 * aplicar, y solo revierte los que siguen siendo el mismo archivo. Si algo
 * cambio despues, ese movimiento se omite y se reporta, en lugar de pisar
 * trabajo nuevo.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AppliedMove } from './types.ts';
import { isInside } from './fsx/paths.ts';

export interface MoveRequest {
  from: string;
  to: string;
}

export interface ApplyResult {
  applied: AppliedMove[];
  failures: { from: string; to: string; error: string }[];
  removedDirs: string[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

function tmpFor(target: string, i: number): string {
  return path.join(path.dirname(target), `.renamer-tmp-${process.pid}-${i}`);
}

export async function applyMoves(
  root: string,
  requests: MoveRequest[],
  opts: { deleteEmptyDirs: boolean; emptyDirs: string[] },
): Promise<ApplyResult> {
  const applied: AppliedMove[] = [];
  const failures: ApplyResult['failures'] = [];
  const staged: { tmp: string; to: string; from: string; ino: number; size: number }[] = [];

  // Fase 1: todo a un nombre temporal junto a su destino.
  for (const [i, req] of requests.entries()) {
    if (req.from === req.to) continue;
    if (!isInside(root, req.from) || !isInside(root, req.to)) {
      failures.push({ from: req.from, to: req.to, error: 'Fuera de la carpeta de trabajo' });
      continue;
    }
    const tmp = tmpFor(req.to, i);
    try {
      const st = await fs.stat(req.from);
      await fs.mkdir(path.dirname(req.to), { recursive: true });
      await fs.rename(req.from, tmp);
      staged.push({ tmp, to: req.to, from: req.from, ino: Number(st.ino), size: st.size });
    } catch (err) {
      failures.push({ from: req.from, to: req.to, error: (err as Error).message });
    }
  }

  // Fase 2: del temporal al destino final, sin pisar nada.
  for (const s of staged) {
    try {
      if (await exists(s.to)) throw new Error(`El destino aparecio mientras se aplicaba: ${s.to}`);
      await fs.rename(s.tmp, s.to);
      applied.push({ from: s.from, to: s.to, ino: s.ino, size: s.size });
    } catch (err) {
      // Devolver el archivo a su lugar original antes de reportar.
      let detail = (err as Error).message;
      try {
        await fs.rename(s.tmp, s.from);
      } catch (backErr) {
        detail += ` · no se pudo regresar a su lugar, quedo en ${s.tmp}: ${(backErr as Error).message}`;
      }
      failures.push({ from: s.from, to: s.to, error: detail });
    }
  }

  // Carpetas vacias: solo rmdir, que falla si queda algo dentro.
  const removedDirs: string[] = [];
  if (opts.deleteEmptyDirs) {
    const ordered = [...opts.emptyDirs].sort(
      (a, b) => b.split(path.sep).length - a.split(path.sep).length,
    );
    for (const dir of ordered) {
      if (!isInside(root, dir) || dir === root) continue;
      try {
        await fs.rmdir(dir);
        removedDirs.push(dir);
      } catch {
        // Quedo algo dentro: se deja la carpeta, no es un error que valga reportar.
      }
    }
  }

  return { applied, failures, removedDirs };
}

export interface UndoResult {
  restored: number;
  skipped: { to: string; reason: string }[];
  failures: { to: string; from: string; error: string }[];
}

export async function undoMoves(root: string, moves: AppliedMove[]): Promise<UndoResult> {
  const skipped: UndoResult['skipped'] = [];
  const failures: UndoResult['failures'] = [];
  const staged: { tmp: string; from: string; to: string }[] = [];

  // Fase 1, en orden inverso al aplicado.
  const reversed = [...moves].reverse();
  for (const [i, mv] of reversed.entries()) {
    if (!isInside(root, mv.from) || !isInside(root, mv.to)) {
      skipped.push({ to: mv.to, reason: 'Fuera de la carpeta de trabajo' });
      continue;
    }
    let st;
    try {
      st = await fs.stat(mv.to);
    } catch {
      skipped.push({ to: mv.to, reason: 'El archivo ya no esta donde quedo' });
      continue;
    }
    if (Number(st.ino) !== mv.ino) {
      skipped.push({ to: mv.to, reason: 'Ahora hay otro archivo con ese nombre' });
      continue;
    }
    const tmp = tmpFor(mv.from, i);
    try {
      await fs.mkdir(path.dirname(mv.from), { recursive: true });
      await fs.rename(mv.to, tmp);
      staged.push({ tmp, from: mv.from, to: mv.to });
    } catch (err) {
      failures.push({ to: mv.to, from: mv.from, error: (err as Error).message });
    }
  }

  // Fase 2.
  let restored = 0;
  for (const s of staged) {
    try {
      if (await exists(s.from)) throw new Error(`Ya existe algo en el lugar original: ${s.from}`);
      await fs.rename(s.tmp, s.from);
      restored++;
    } catch (err) {
      let detail = (err as Error).message;
      try {
        await fs.rename(s.tmp, s.to);
      } catch (backErr) {
        detail += ` · quedo en ${s.tmp}: ${(backErr as Error).message}`;
      }
      failures.push({ to: s.to, from: s.from, error: detail });
    }
  }

  return { restored, skipped, failures };
}
