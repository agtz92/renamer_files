/**
 * Construccion del plan. Es la pieza central: la tabla que ve el usuario es
 * exactamente esta estructura, y el apply solo ejecuta lo que aqui se decidio.
 *
 * El reparto de nombres va en dos pasadas, y el orden importa:
 *  1. Los archivos que ya estan en su lugar con su nombre tienen derecho
 *     preferente sobre ese nombre. Si un archivo que se va a renombrar quisiera
 *     ese mismo nombre, el que cede es el que se mueve, no el que ya estaba.
 *  2. El resto reclama su nombre en orden de escaneo, con sufijo -2, -3 cuando
 *     el que pedia ya esta tomado.
 *
 * Dos detalles de macOS:
 *  - APFS es insensible a mayusculas por defecto, asi que las colisiones se
 *    comparan en minusculas.
 *  - Un destino ocupado por un archivo que no entra al plan (oculto, filtrado
 *    por extension, o fuera del escaneo) tambien es una colision real.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { matchFile, splitExt } from './rules/match.ts';
import { renderTemplate } from './rules/template.ts';
import { scanFiles, findEmptyAfterMove } from './fsx/scan.ts';
import type { MatchResult, Plan, PlanItem, Rule, ScanOptions } from './types.ts';
import type { ScannedFile } from './fsx/scan.ts';

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

interface Draft {
  file: ScannedFile;
  ext: string;
  destDir: string;
  /** Nombre que pide, antes de resolver colisiones. */
  wanted: string;
  matched: boolean;
  error: string | null;
  /** Se queda exactamente donde esta y como esta. */
  staysPut: boolean;
}

export async function buildPlan(
  root: string,
  rule: Rule,
  options: ScanOptions,
  ignoreNames: string[],
): Promise<Plan> {
  const files = await scanFiles(root, options, ignoreNames);
  const sourcesLower = new Set(files.map((f) => f.abs.toLowerCase()));
  const rootName = path.basename(root);

  // --- Pasada previa: que nombre quiere cada archivo ---
  const drafts: Draft[] = [];
  let matchIndex = 0;

  for (const file of files) {
    const [stem, ext] = splitExt(file.name);
    const destDir = options.flatten ? root : file.dir;

    let match: MatchResult | null = null;
    let error: string | null = null;
    try {
      match = matchFile(file.name, rule);
    } catch (err) {
      error = (err as Error).message;
    }

    let wanted = file.name;
    let matched = false;
    if (!error && match) {
      matchIndex++;
      try {
        wanted = renderTemplate(rule.template, { match, ext, stem, index: matchIndex, rootName });
        matched = true;
      } catch (err) {
        error = (err as Error).message;
      }
    }

    const staysPut = !error && destDir === file.dir && wanted === file.name;
    drafts.push({ file, ext, destDir, wanted, matched, error, staysPut });
  }

  // --- Reparto de nombres ---
  const taken = new Set<string>();
  for (const d of drafts) {
    if (d.error) continue;
    if (d.staysPut) taken.add(d.file.abs.toLowerCase());
  }

  const finalName = new Map<string, { name: string; suffix: number }>();
  for (const d of drafts) {
    if (d.error) continue;
    if (d.staysPut) {
      finalName.set(d.file.abs, { name: d.file.name, suffix: 1 });
      continue;
    }
    const [tStem, tExt] = splitExt(d.wanted);
    let candidate = d.wanted;
    let suffix = 1;
    for (;;) {
      const abs = path.join(d.destDir, candidate);
      const key = abs.toLowerCase();
      const isSelf = key === d.file.abs.toLowerCase();
      const reserved = taken.has(key) && !isSelf;
      const occupiedByOutsider = !isSelf && !sourcesLower.has(key) && (await exists(abs));
      if (!reserved && !occupiedByOutsider) break;
      suffix++;
      candidate = `${tStem}-${suffix}${tExt}`;
      if (suffix > 999) throw new Error(`No pude resolver la colision de ${d.wanted}`);
    }
    taken.add(path.join(d.destDir, candidate).toLowerCase());
    finalName.set(d.file.abs, { name: candidate, suffix });
  }

  // --- Items en el orden del escaneo ---
  const items: PlanItem[] = drafts.map((d) => {
    if (d.error) {
      return {
        relPath: d.file.relPath,
        sourceAbs: d.file.abs,
        baseName: d.file.name,
        ext: d.ext,
        targetName: d.file.name,
        targetAbs: d.file.abs,
        status: 'error' as const,
        moves: false,
        renames: false,
        selected: false,
        note: d.error,
        size: d.file.size,
      };
    }

    const resolved = finalName.get(d.file.abs)!;
    const targetAbs = path.join(d.destDir, resolved.name);
    const moves = path.dirname(targetAbs) !== d.file.dir;
    const renames = path.basename(targetAbs) !== d.file.name;

    let status: PlanItem['status'];
    let note = '';
    if (!moves && !renames) {
      status = 'unchanged';
      note = 'Ya tiene el nombre y el lugar correctos';
    } else if (resolved.suffix > 1) {
      status = 'collision';
      note = `Ya habia un ${d.wanted}, se usa el sufijo -${resolved.suffix}`;
    } else if (d.matched) {
      status = 'ok';
    } else {
      status = 'nomatch';
      note = 'El nombre no coincide, solo se mueve';
    }

    return {
      relPath: d.file.relPath,
      sourceAbs: d.file.abs,
      baseName: d.file.name,
      ext: d.ext,
      targetName: resolved.name,
      targetAbs,
      status,
      moves,
      renames,
      selected: status !== 'unchanged',
      note,
      size: d.file.size,
    };
  });

  const movingFiles = new Set(items.filter((i) => i.selected && i.moves).map((i) => i.sourceAbs));
  const emptyDirs =
    options.flatten && options.deleteEmptyDirs
      ? await findEmptyAfterMove(root, movingFiles, ignoreNames)
      : [];

  const counts = {
    total: items.length,
    ok: items.filter((i) => i.status === 'ok').length,
    nomatch: items.filter((i) => i.status === 'nomatch').length,
    collision: items.filter((i) => i.status === 'collision').length,
    unchanged: items.filter((i) => i.status === 'unchanged').length,
    error: items.filter((i) => i.status === 'error').length,
  };

  return { root, rule, options, items, emptyDirs, counts };
}
