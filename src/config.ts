/**
 * Configuracion del servicio. Las "roots" son el limite de seguridad: nada
 * fuera de ellas se lista, se lee ni se toca, por mas que llegue una ruta
 * absoluta en la peticion.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  port: number;
  host: string;
  roots: string[];
  ignoreNames: string[];
  historyLimit: number;
  dataDir: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

export function loadConfig(): Config {
  const file = process.env.RENAMER_CONFIG ?? path.join(projectRoot, 'renamer.config.json');
  let raw: Partial<Config> = {};
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Config>;
    } catch (err) {
      // Un JSON roto si es un error: arrancar con defaults escondería el problema.
      throw new Error(`La configuracion en ${file} no es JSON valido: ${(err as Error).message}`);
    }
  } else {
    console.warn(`[renamer] no hay ${path.basename(file)}; copia renamer.config.example.json y ajusta roots`);
  }

  const envRoots = process.env.RENAMER_ROOTS;
  const rootList = envRoots ? envRoots.split(':').filter(Boolean) : (raw.roots ?? []);

  const roots: string[] = [];
  for (const r of rootList) {
    try {
      roots.push(realpathSync(r));
    } catch {
      // Una root que no existe (un volumen desmontado) se omite con aviso, no tumba el servicio.
      console.warn(`[renamer] root no disponible, se omite: ${r}`);
    }
  }
  if (roots.length === 0) {
    console.warn('[renamer] ninguna root disponible: la UI no podra listar nada');
  }

  return {
    port: Number(process.env.PORT ?? raw.port ?? 7845),
    host: process.env.HOST ?? raw.host ?? '0.0.0.0',
    roots,
    ignoreNames: raw.ignoreNames ?? ['.DS_Store'],
    historyLimit: raw.historyLimit ?? 500,
    dataDir: process.env.RENAMER_DATA ?? path.join(projectRoot, 'data'),
  };
}
