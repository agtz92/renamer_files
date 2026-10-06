/**
 * Resolucion de rutas con el limite de las roots.
 * Se usa realpath para que un symlink no pueda sacar la operacion de la root.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';

export class OutsideRootError extends Error {
  constructor(p: string) {
    super(`La ruta esta fuera de las carpetas permitidas: ${p}`);
    this.name = 'OutsideRootError';
  }
}

export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Normaliza una ruta que llego de la UI y verifica que viva dentro de alguna root.
 * Devuelve la ruta real (symlinks resueltos).
 */
export function resolveInRoots(input: string, roots: string[]): string {
  if (typeof input !== 'string' || input.trim() === '') throw new OutsideRootError(String(input));
  const abs = path.resolve(input.trim());
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    // No existe todavia (un destino): validamos el padre, que si debe existir.
    const parent = realpathSync(path.dirname(abs));
    real = path.join(parent, path.basename(abs));
  }
  for (const root of roots) {
    if (isInside(root, real)) return real;
  }
  throw new OutsideRootError(input);
}
