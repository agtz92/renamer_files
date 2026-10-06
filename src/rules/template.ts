/**
 * Render de la plantilla de salida.
 *
 * Piezas disponibles:
 *   {#} {#:02} {#:03}   numero principal (episodio, o el primer numero capturado)
 *   {e} {e:02}          episodio
 *   {s} {s:02}          temporada
 *   {1} {2} {1:02}      numeros capturados por posicion
 *   {ext}               extension con punto, p.ej. ".mkv"
 *   {resto}             lo que sobra del nombre despues de la coincidencia
 *   {nombre}            el nombre original sin extension
 *   {carpeta}           nombre de la carpeta elegida, util como nombre de serie
 *   {n} {n:02}          consecutivo asignado por el planner
 *
 * Una pieza desconocida o sin valor es un error explicito, no se rellena en
 * silencio: un nombre a medias es peor que un error visible.
 */
import type { MatchResult } from '../types.ts';

export interface TemplateContext {
  match: MatchResult | null;
  ext: string;
  /** Nombre original sin extension. */
  stem: string;
  /** Consecutivo 1..n dentro del plan, para {n}. */
  index: number;
  /** Nombre de la carpeta de trabajo, para {carpeta}. */
  rootName: string;
}

const TOKEN = /\{([^}]*)\}/g;

function pad(value: number, spec: string | undefined): string {
  if (spec === undefined || spec === '') return String(value);
  const width = Number.parseInt(spec, 10);
  if (!Number.isFinite(width) || width < 1 || width > 10) {
    throw new Error(`Ancho invalido en la plantilla: "${spec}"`);
  }
  return String(value).padStart(width, '0');
}

/** Caracteres que no pueden ir en un nombre de archivo. */
export function sanitizeName(name: string): string {
  return name
    .replace(/[/\\\u0000]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

export function renderTemplate(template: string, ctx: TemplateContext): string {
  if (template.trim() === '') throw new Error('La plantilla esta vacia');

  const out = template.replace(TOKEN, (_full, body: string) => {
    const [rawKey, spec] = body.split(':', 2) as [string, string | undefined];
    const key = rawKey.trim();
    const m = ctx.match;

    if (key === 'ext') return ctx.ext;
    if (key === 'nombre') return ctx.stem;
    if (key === 'carpeta') return ctx.rootName;
    if (key === 'resto') return m ? m.rest : ctx.stem;
    if (key === 'n') return pad(ctx.index, spec);

    if (key === '#' || key === 'e') {
      const value = m ? (m.episode ?? m.numbers[0] ?? null) : null;
      if (value === null) throw new Error(`No hay numero para {${body}}`);
      return pad(value, spec);
    }
    if (key === 's') {
      const value = m ? m.season : null;
      if (value === null) throw new Error('El patron no captura temporada, {s} no se puede usar');
      return pad(value, spec);
    }
    if (/^\d+$/.test(key)) {
      const pos = Number.parseInt(key, 10);
      const value = m ? m.numbers[pos - 1] : undefined;
      if (value === undefined) throw new Error(`El patron no captura un numero en la posicion ${pos}`);
      return pad(value, spec);
    }
    throw new Error(`Pieza desconocida en la plantilla: {${body}}`);
  });

  const clean = sanitizeName(out);
  if (clean === '' || clean === '.' || clean === '..') {
    throw new Error('La plantilla produce un nombre vacio');
  }
  return clean;
}
