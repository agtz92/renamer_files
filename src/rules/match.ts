/**
 * Los tres modos de identificacion de archivos.
 *
 * - auto    : prueba los formatos comunes de episodio, en orden.
 * - pattern : el usuario escribe texto literal con # donde va el numero
 *             (y * para "cualquier cosa"). Es el modo por defecto de la UI.
 * - regex   : expresion regular cruda, con grupos nombrados s y e opcionales.
 *
 * Todos devuelven la misma MatchResult, de forma que la plantilla no sabe
 * cual de los tres la produjo.
 */
import type { MatchResult, Rule } from '../types.ts';

/** Patrones de auto, del mas especifico al mas laxo. */
const AUTO_PATTERNS: { re: RegExp; season: number | null; episode: number }[] = [
  // S01E02, s1e2, S01.E02, S01 E02
  { re: /[Ss](\d{1,3})[\s._-]*[Ee](\d{1,3})(?!\d)/, season: 1, episode: 2 },
  // 1x02  (el limite de digitos evita que 1920x1080 cuente)
  { re: /(?<![\d])(\d{1,2})[xX](\d{2,3})(?![\dxX])/, season: 1, episode: 2 },
  // Episode 1, Episodio 1, Capitulo 1, Ep.01, E05
  {
    re: /(?:[Ee]pisodio|[Ee]pisode|[Cc]ap[ií]tulo|[Cc]apitulo|[Ee]p\.?|[Ee])[\s._-]*(\d{1,4})(?!\d)/,
    season: null,
    episode: 1,
  },
  // " - 05 " / "_-_05."
  { re: /[\s._]-[\s._]*(\d{1,4})(?!\d)/, season: null, episode: 1 },
  // [05]
  { re: /\[(\d{1,4})\](?!\d)/, season: null, episode: 1 },
];

/** Separa "nombre.mkv" en ["nombre", ".mkv"]. Un punto inicial no es extension. */
export function splitExt(fileName: string): [string, string] {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return [fileName, ''];
  return [fileName.slice(0, dot), fileName.slice(dot)];
}

/** Limpia lo que sobra del nombre: separadores colgando, dobles espacios. */
function cleanRest(rest: string): string {
  // Los puntos y guiones bajos de los nombres de release funcionan como
  // espacios, asi que {resto} los convierte en espacios de verdad.
  return rest
    .replace(/[._]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-\[(]+/, '')
    .replace(/[\s\-\])]+$/, '')
    .trim();
}

function build(
  stem: string,
  m: RegExpMatchArray,
  seasonGroup: number | null,
  episodeGroup: number | null,
  extraGroups: number[],
): MatchResult {
  const num = (g: number | null): number | null => {
    if (g === null) return null;
    const raw = m[g];
    if (raw === undefined || raw === '') return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  };
  const season = num(seasonGroup);
  const episode = num(episodeGroup);
  const numbers: number[] = [];
  if (season !== null) numbers.push(season);
  if (episode !== null) numbers.push(episode);
  for (const g of extraGroups) {
    const n = num(g);
    if (n !== null) numbers.push(n);
  }
  const matchedText = m[0];
  const start = m.index ?? 0;
  const rest = cleanRest(stem.slice(0, start) + ' ' + stem.slice(start + matchedText.length));
  return { season, episode, numbers, matchedText, rest };
}

export function matchAuto(fileName: string): MatchResult | null {
  const [stem] = splitExt(fileName);
  for (const p of AUTO_PATTERNS) {
    const m = stem.match(p.re);
    if (m) return build(stem, m, p.season, p.episode, []);
  }
  return null;
}

/**
 * Convierte un patron humano en regex.
 * Todo es literal salvo:
 *   #  -> un numero de 1 a 4 digitos
 *   *  -> cualquier cosa, lo mas corto posible
 * La busqueda no distingue mayusculas y es flexible con el tipo de separador:
 * un espacio en el patron acepta espacio, punto, guion o guion bajo.
 */
export function patternToRegex(pattern: string): RegExp {
  let src = '';
  for (const ch of pattern) {
    if (ch === '#') src += '(\\d{1,4})';
    else if (ch === '*') src += '.*?';
    else if (ch === ' ') src += '[\\s._-]*';
    else src += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(src, 'i');
}

export function matchPattern(fileName: string, pattern: string): MatchResult | null {
  if (pattern.trim() === '') return null;
  const [stem] = splitExt(fileName);
  const m = stem.match(patternToRegex(pattern));
  if (!m) return null;
  const groups = m.length - 1;
  if (groups === 0) {
    return { season: null, episode: null, numbers: [], matchedText: m[0], rest: cleanRest(stem.replace(m[0], ' ')) };
  }
  if (groups === 1) return build(stem, m, null, 1, []);
  // Dos o mas numeros: el primero es temporada, el segundo episodio.
  const extra: number[] = [];
  for (let i = 3; i <= groups; i++) extra.push(i);
  return build(stem, m, 1, 2, extra);
}

export function matchRegex(fileName: string, source: string): MatchResult | null {
  if (source.trim() === '') return null;
  const [stem] = splitExt(fileName);
  let re: RegExp;
  try {
    re = new RegExp(source, 'i');
  } catch (err) {
    throw new Error(`Expresion regular invalida: ${(err as Error).message}`);
  }
  const m = stem.match(re);
  if (!m) return null;
  const named = m.groups ?? {};
  if (named.e !== undefined || named.s !== undefined) {
    const season = named.s !== undefined ? Number.parseInt(named.s, 10) : null;
    const episode = named.e !== undefined ? Number.parseInt(named.e, 10) : null;
    const numbers: number[] = [];
    if (season !== null && Number.isFinite(season)) numbers.push(season);
    if (episode !== null && Number.isFinite(episode)) numbers.push(episode);
    const start = m.index ?? 0;
    return {
      season: season !== null && Number.isFinite(season) ? season : null,
      episode: episode !== null && Number.isFinite(episode) ? episode : null,
      numbers,
      matchedText: m[0],
      rest: cleanRest(stem.slice(0, start) + ' ' + stem.slice(start + m[0].length)),
    };
  }
  const groups = m.length - 1;
  if (groups === 0) {
    return { season: null, episode: null, numbers: [], matchedText: m[0], rest: cleanRest(stem.replace(m[0], ' ')) };
  }
  if (groups === 1) return build(stem, m, null, 1, []);
  const extra: number[] = [];
  for (let i = 3; i <= groups; i++) extra.push(i);
  return build(stem, m, 1, 2, extra);
}

/** Punto de entrada unico: aplica la regla al nombre del archivo. */
export function matchFile(fileName: string, rule: Rule): MatchResult | null {
  if (rule.mode === 'auto') return matchAuto(fileName);
  if (rule.mode === 'pattern') return matchPattern(fileName, rule.pattern);
  return matchRegex(fileName, rule.pattern);
}
