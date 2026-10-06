/**
 * Lectura del disco: navegar carpetas para el selector, enumerar archivos para
 * el plan y encontrar las carpetas que quedarian vacias.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ScanOptions } from '../types.ts';

export interface DirEntryInfo {
  name: string;
  abs: string;
  fileCount: number;
  dirCount: number;
}

export interface ScannedFile {
  abs: string;
  relPath: string;
  name: string;
  size: number;
  dir: string;
}

function isIgnored(name: string, ignoreNames: string[]): boolean {
  return name.startsWith('.') || ignoreNames.includes(name);
}

/** Subcarpetas inmediatas, con un conteo somero de lo que tiene cada una. */
export async function listDirectories(dir: string, ignoreNames: string[]): Promise<DirEntryInfo[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: DirEntryInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || isIgnored(e.name, ignoreNames)) continue;
    const abs = path.join(dir, e.name);
    let fileCount = 0;
    let dirCount = 0;
    try {
      for (const inner of await fs.readdir(abs, { withFileTypes: true })) {
        if (isIgnored(inner.name, ignoreNames)) continue;
        if (inner.isDirectory()) dirCount++;
        else fileCount++;
      }
    } catch {
      // Sin permiso de lectura: se muestra con conteo 0 en lugar de desaparecer.
    }
    out.push({ name: e.name, abs, fileCount, dirCount });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));
  return out;
}

/** Todos los archivos bajo root segun las opciones, ordenados de forma estable. */
export async function scanFiles(root: string, options: ScanOptions, ignoreNames: string[]): Promise<ScannedFile[]> {
  const found: ScannedFile[] = [];
  const exts = options.extensions.map((e) => e.toLowerCase().replace(/^\./, ''));

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (isIgnored(e.name, ignoreNames)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (options.includeSubfolders) await walk(abs);
        continue;
      }
      if (!e.isFile()) continue; // symlinks, fifos y demas se quedan fuera
      if (exts.length > 0) {
        const ext = path.extname(e.name).slice(1).toLowerCase();
        if (!exts.includes(ext)) continue;
      }
      let size = 0;
      try {
        size = (await fs.stat(abs)).size;
      } catch {
        continue;
      }
      found.push({
        abs,
        relPath: path.relative(root, abs).split(path.sep).join('/'),
        name: e.name,
        size,
        dir,
      });
    }
  }

  await walk(root);
  found.sort((a, b) => a.relPath.localeCompare(b.relPath, 'es', { numeric: true }));
  return found;
}

/**
 * Carpetas que quedarian vacias si se movieran los archivos indicados.
 * Se evalua de abajo hacia arriba: una carpeta cuyo unico contenido son
 * carpetas que tambien quedan vacias, queda vacia.
 */
export async function findEmptyAfterMove(
  root: string,
  movedFiles: Set<string>,
  ignoreNames: string[],
): Promise<string[]> {
  const willBeEmpty: string[] = [];

  async function visit(dir: string): Promise<boolean> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    let keepsSomething = false;
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        const childEmpty = await visit(abs);
        if (!childEmpty) keepsSomething = true;
      } else if (isIgnored(e.name, ignoreNames)) {
        // Los archivos ignorados no cuentan como contenido: una carpeta con
        // solo .DS_Store se considera vacia, pero no se borra sola (el apply
        // borra el .DS_Store solo si el usuario lo pidio).
      } else if (!movedFiles.has(abs)) {
        keepsSomething = true;
      }
    }
    if (!keepsSomething && dir !== root) willBeEmpty.push(dir);
    return !keepsSomething;
  }

  await visit(root);
  // Mas profundas primero, que es el orden en que hay que borrarlas.
  willBeEmpty.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
  return willBeEmpty;
}
