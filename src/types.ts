/**
 * Tipos compartidos entre el motor, el servidor y la UI.
 * La UI consume exactamente estas formas via JSON, asi que cualquier cambio
 * aqui es un cambio de contrato con public/app.js.
 */

export type RuleMode = 'auto' | 'pattern' | 'regex';

export interface Rule {
  mode: RuleMode;
  /** Vacio en modo auto. En modo pattern usa # para el numero y * para cualquier cosa. */
  pattern: string;
  /** Plantilla del nombre final, p.ej. "S01E{#:02}{ext}". */
  template: string;
}

export interface MatchResult {
  /** Temporada, solo cuando el patron la captura. */
  season: number | null;
  /** Numero principal (episodio). Es el que alimenta {#}. */
  episode: number | null;
  /** Todos los numeros capturados, en orden, para {1} {2} ... */
  numbers: number[];
  /** El texto exacto que coincidio. */
  matchedText: string;
  /** Lo que queda del nombre (sin extension) despues de quitar la coincidencia. */
  rest: string;
}

export interface ScanOptions {
  includeSubfolders: boolean;
  /** Mover todo a la raiz de la carpeta elegida. */
  flatten: boolean;
  /** Borrar las carpetas que queden vacias despues de mover. */
  deleteEmptyDirs: boolean;
  /** Extensiones permitidas, sin punto y en minusculas. Vacio = todas. */
  extensions: string[];
}

export type PlanStatus = 'ok' | 'nomatch' | 'collision' | 'unchanged' | 'error';

export interface PlanItem {
  /** Ruta relativa a la carpeta elegida, con separadores /. */
  relPath: string;
  sourceAbs: string;
  baseName: string;
  /** Extension con punto, o cadena vacia. */
  ext: string;
  targetName: string;
  targetAbs: string;
  status: PlanStatus;
  /** true cuando el archivo cambia de carpeta. */
  moves: boolean;
  /** true cuando el nombre cambia. */
  renames: boolean;
  selected: boolean;
  note: string;
  size: number;
}

export interface Plan {
  root: string;
  rule: Rule;
  options: ScanOptions;
  items: PlanItem[];
  emptyDirs: string[];
  counts: {
    total: number;
    ok: number;
    nomatch: number;
    collision: number;
    unchanged: number;
    error: number;
  };
}

export interface AppliedMove {
  from: string;
  to: string;
  /** inode al momento de aplicar: es la identidad que valida el undo. */
  ino: number;
  size: number;
}

export interface Operation {
  id: number;
  root: string;
  createdAt: string;
  rule: Rule;
  options: ScanOptions;
  moves: AppliedMove[];
  removedDirs: string[];
  failures: { from: string; to: string; error: string }[];
  undoneAt: string | null;
}
