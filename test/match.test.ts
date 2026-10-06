import test from 'node:test';
import assert from 'node:assert/strict';
import { matchAuto, matchPattern, matchRegex, patternToRegex, splitExt } from '../src/rules/match.ts';
import { renderTemplate } from '../src/rules/template.ts';

test('splitExt separa la extension y respeta los nombres sin punto', () => {
  assert.deepEqual(splitExt('S01E01.mkv'), ['S01E01', '.mkv']);
  assert.deepEqual(splitExt('sin_extension'), ['sin_extension', '']);
  assert.deepEqual(splitExt('.DS_Store'), ['.DS_Store', '']);
  assert.deepEqual(splitExt('a.b.mkv'), ['a.b', '.mkv']);
});

test('auto reconoce los formatos de episodio comunes', () => {
  assert.deepEqual(
    { s: matchAuto('[Sokudo] Kusuriya - S01E24 [1080p].mkv')?.season, e: matchAuto('[Sokudo] Kusuriya - S01E24 [1080p].mkv')?.episode },
    { s: 1, e: 24 },
  );
  assert.equal(matchAuto('The Show - s1.e2 - El Gato.mp4')?.episode, 2);
  assert.equal(matchAuto('Show 1x02 algo.mkv')?.episode, 2);
  assert.equal(matchAuto('[Grupo] Akame ga Kill - Episode 7 [1080p].mkv')?.episode, 7);
  assert.equal(matchAuto('Serie Capitulo 12.avi')?.episode, 12);
  assert.equal(matchAuto('Serie - 05 (BD).mkv')?.episode, 5);
  assert.equal(matchAuto('Serie [04].mkv')?.episode, 4);
});

test('auto no confunde una resolucion con un episodio', () => {
  assert.equal(matchAuto('Pelicula 1920x1080 HDR.mkv'), null);
  assert.equal(matchAuto('Extras 1080p x264.mkv'), null);
  assert.equal(matchAuto('folder.jpg'), null);
});

test('patron con # captura el numero y trata el resto como literal', () => {
  const m = matchPattern('[Sokudo] Akame ga Kill - Episode 12 [1080p].mkv', 'Episode #');
  assert.equal(m?.episode, 12);
  assert.equal(matchPattern('spanish.ass', 'Episode #'), null);
});

test('el patron escapa los caracteres especiales de regex', () => {
  assert.equal(patternToRegex('[Sokudo] #').test('[Sokudo] 4'), true);
  assert.equal(patternToRegex('(v#)').test('(v2)'), true);
  // Un punto en el patron no debe funcionar como comodin de regex.
  assert.equal(patternToRegex('Ep.#').test('EpX5'), false);
});

test('el espacio del patron acepta cualquier separador', () => {
  assert.equal(matchPattern('Show.Episode.9.mkv', 'Episode #')?.episode, 9);
  assert.equal(matchPattern('Show_Episode_9.mkv', 'Episode #')?.episode, 9);
  assert.equal(matchPattern('Show-Episode-9.mkv', 'Episode #')?.episode, 9);
});

test('dos numeros en el patron son temporada y episodio', () => {
  const m = matchPattern('Serie T2 Cap 14.mkv', 'T# Cap #');
  assert.equal(m?.season, 2);
  assert.equal(m?.episode, 14);
});

test('regex acepta grupos nombrados s y e', () => {
  const m = matchRegex('Serie 02-14 final.mkv', '(?<s>\\d{2})-(?<e>\\d{2})');
  assert.equal(m?.season, 2);
  assert.equal(m?.episode, 14);
});

test('una regex invalida se reporta, no se traga', () => {
  assert.throws(() => matchRegex('x.mkv', '('), /invalida/i);
});

test('rest se queda con lo que sobra del nombre, limpio', () => {
  const m = matchAuto('The.Show.S01E02.The.Cat.Came.Back.1080p.mkv');
  assert.equal(m?.rest.includes('The Cat Came Back'), true);
  assert.equal(m?.rest.startsWith('.'), false);
});

test('la plantilla rellena numero, extension y consecutivo', () => {
  const m = matchAuto('Show Episode 4.mkv');
  assert.equal(renderTemplate('S01E{#:02}{ext}', { match: m, ext: '.mkv', stem: 'Show Episode 4', index: 1, rootName: 'Akame Ga Kill' }), 'S01E04.mkv');
  assert.equal(renderTemplate('{n:03} - {resto}{ext}', { match: m, ext: '.mkv', stem: 'Show Episode 4', index: 7, rootName: 'Akame Ga Kill' }), '007 - Show.mkv');
});

test('la plantilla usa temporada cuando el patron la captura', () => {
  const m = matchAuto('Serie S02E09.mkv');
  assert.equal(renderTemplate('S{s:02}E{e:02}{ext}', { match: m, ext: '.mkv', stem: 'Serie S02E09', index: 1, rootName: 'Akame Ga Kill' }), 'S02E09.mkv');
});

test('la plantilla falla claro cuando falta un dato', () => {
  const m = matchAuto('Show Episode 4.mkv');
  assert.throws(() => renderTemplate('S{s:02}E{e:02}{ext}', { match: m, ext: '.mkv', stem: 'x', index: 1, rootName: 'Akame Ga Kill' }), /temporada/i);
  assert.throws(() => renderTemplate('{loquesea}{ext}', { match: m, ext: '.mkv', stem: 'x', index: 1, rootName: 'Akame Ga Kill' }), /desconocida/i);
  assert.throws(() => renderTemplate('', { match: m, ext: '.mkv', stem: 'x', index: 1, rootName: 'Akame Ga Kill' }), /vacia/i);
});

test('la plantilla nunca produce separadores de ruta', () => {
  const m = matchAuto('Show Episode 4.mkv');
  const out = renderTemplate('../{#}{ext}', { match: m, ext: '.mkv', stem: 'x', index: 1, rootName: 'Akame Ga Kill' });
  assert.equal(out.includes('/'), false);
  assert.equal(out, '.._4.mkv');
});

test('{carpeta} usa el nombre de la carpeta elegida como nombre de serie', () => {
  const m = matchAuto('[Grupo] serie - Episode 1 [1080p].mkv');
  assert.equal(
    renderTemplate('S01E{#:02}-{carpeta}{ext}', {
      match: m,
      ext: '.mkv',
      stem: '[Grupo] serie - Episode 1 [1080p]',
      index: 1,
      rootName: 'Akame Ga Kill',
    }),
    'S01E01-Akame Ga Kill.mkv',
  );
});

test('el texto literal de la plantilla se copia tal cual', () => {
  const m = matchAuto('Show Episode 3.mkv');
  const ctx = { match: m, ext: '.mkv', stem: 'Show Episode 3', index: 1, rootName: 'Carpeta' };
  assert.equal(renderTemplate('S01E{#:02}-Akame ga Kill{ext}', ctx), 'S01E03-Akame ga Kill.mkv');
  assert.equal(renderTemplate('Mi Serie {#} final{ext}', ctx), 'Mi Serie 3 final.mkv');
});
