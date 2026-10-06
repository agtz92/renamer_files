// UI de Renamer. Vanilla, sin build: el servidor sirve este archivo tal cual.
// La regla de oro: la tabla que se ve es exactamente lo que se manda al apply.

const $ = (id) => document.getElementById(id);

const state = {
  root: '',
  mode: 'pattern',
  pattern: 'Episode #',
  template: 'S01E{#:02}{ext}',
  options: { includeSubfolders: true, flatten: true, deleteEmptyDirs: true, extensions: [] },
  plan: null,
  deselected: new Set(), // relPath de las filas que el usuario destildó
  lastOperation: null,
  picker: { path: '', parent: null, dirs: [] },
  busy: false,
};

const HINTS = {
  auto: 'Detecta S01E02, 1x02, Episode 4, Capítulo 12, - 05 y [04]. No necesitas escribir nada.',
  pattern: '# es el número que cambia, * es cualquier cosa. El resto es literal, sin importar mayúsculas.',
  regex: 'Expresión regular. Usa grupos nombrados (?<s>…) y (?<e>…) para temporada y episodio.',
};

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Error ${res.status}`);
  return body;
}

function esc(text) {
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

function fmtBytes(n) {
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function fmtWhen(iso) {
  const d = new Date(iso);
  return d.toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
}

// ---------- plan ----------

let planTimer = null;
function schedulePlan() {
  clearTimeout(planTimer);
  planTimer = setTimeout(loadPlan, 350);
}

async function loadPlan() {
  if (!state.root.trim()) {
    state.plan = null;
    render();
    return;
  }
  $('plan-summary').textContent = 'Calculando…';
  try {
    const plan = await api('/api/plan', {
      method: 'POST',
      body: JSON.stringify({
        root: state.root,
        rule: { mode: state.mode, pattern: state.pattern, template: state.template },
        options: state.options,
      }),
    });
    state.plan = plan;
    state.root = plan.root;
    $('root').value = plan.root;
  } catch (err) {
    state.plan = null;
    showBanner('bad', err.message, null);
  }
  render();
}

function selectedItems() {
  if (!state.plan) return [];
  return state.plan.items.filter(
    (i) => i.status !== 'unchanged' && i.status !== 'error' && !state.deselected.has(i.relPath),
  );
}

// ---------- render ----------

function render() {
  const plan = state.plan;
  const hasPlan = plan && plan.items.length > 0;

  $('pattern-hint').textContent = HINTS[state.mode];
  $('pattern').disabled = state.mode === 'auto';
  $('pattern').placeholder = state.mode === 'regex' ? '(?<s>\\d+)x(?<e>\\d+)' : 'Episode #';
  $('pattern-label').textContent = state.mode === 'regex' ? 'Expresión regular' : 'Identifica los archivos con';

  renderTemplateHint(plan, hasPlan);

  $('empty-state').classList.toggle('hidden', Boolean(state.root.trim()));
  $('table-card').classList.toggle('hidden', !state.root.trim());

  // métricas
  const c = plan ? plan.counts : { ok: 0, nomatch: 0, collision: 0, unchanged: 0, error: 0 };
  $('metrics').innerHTML = [
    metric('Coinciden', c.ok + c.collision, ''),
    metric('Sin coincidencia', c.nomatch, c.nomatch ? 'warn' : ''),
    metric('Colisiones', c.collision, c.collision ? 'bad' : ''),
    metric('Carpetas a borrar', plan ? plan.emptyDirs.length : 0, ''),
    c.error ? metric('Errores de regla', c.error, 'bad') : '',
  ].join('');

  // filas
  const rows = $('rows');
  rows.innerHTML = '';
  if (hasPlan) {
    const frag = document.createDocumentFragment();
    for (const item of plan.items) frag.appendChild(renderRow(item));
    rows.appendChild(frag);
  } else if (state.root.trim()) {
    rows.innerHTML = `<tr><td colspan="4" class="hint" style="padding:24px 20px">No hay archivos que mostrar con estas opciones.</td></tr>`;
  }

  const sel = selectedItems();
  $('apply').disabled = sel.length === 0 || state.busy;
  $('apply').textContent = sel.length ? `Aplicar ${sel.length} cambios` : 'Aplicar';
  $('plan-summary').textContent = hasPlan
    ? `${plan.items.length} archivos · ${sel.length} seleccionados${plan.emptyDirs.length ? ` · ${plan.emptyDirs.length} carpetas quedarían vacías` : ''}`
    : state.root.trim()
      ? 'Sin archivos.'
      : 'Elige una carpeta para empezar.';
}

/**
 * El hint del nombre muestra un archivo real de la carpeta y en que quedaria.
 * Un ejemplo concreto explica la plantilla mejor que la lista de piezas.
 */
function renderTemplateHint(plan, hasPlan) {
  const el = $('template-hint');
  el.className = 'preview';

  const bad = hasPlan ? plan.items.find((i) => i.status === 'error') : null;
  if (bad) {
    el.innerHTML = `<span class="bad">${esc(bad.note)}</span>`;
    return;
  }

  const sample = hasPlan
    ? plan.items.find((i) => i.status === 'ok' || i.status === 'collision')
    : null;
  if (sample) {
    el.innerHTML =
      `<span class="from">${esc(sample.baseName)}</span>` +
      `<span aria-hidden="true" style="color:var(--ink-faint)">&rarr;</span>` +
      `<span class="to">${esc(sample.targetName)}</span>`;
    return;
  }

  if (hasPlan) {
    el.className = 'hint';
    el.textContent = 'Ningún archivo coincide con el patrón, así que no hay nada que nombrar todavía.';
    return;
  }

  el.className = 'hint';
  el.textContent = 'Ejemplo: S01E{#:02}-{carpeta}{ext} deja S01E01-Akame Ga Kill.mkv';
}

function metric(label, value, kind) {
  return `<div class="metric ${kind}"><span class="overline">${label}</span><span class="value">${value}</span></div>`;
}

const BADGE = {
  ok: ['ok', 'Renombra'],
  collision: ['collision', 'Colisión'],
  nomatch: ['nomatch', 'Solo mueve'],
  unchanged: ['unchanged', 'Sin cambios'],
  error: ['error', 'Error'],
};

function renderRow(item) {
  const tr = document.createElement('tr');
  tr.className = item.status;
  const checkable = item.status !== 'unchanged' && item.status !== 'error';
  const checked = checkable && !state.deselected.has(item.relPath);

  const tdCheck = document.createElement('td');
  if (checkable) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = checked;
    box.setAttribute('aria-label', `Incluir ${item.relPath}`);
    box.addEventListener('change', () => {
      if (box.checked) state.deselected.delete(item.relPath);
      else state.deselected.add(item.relPath);
      render();
    });
    tdCheck.appendChild(box);
  }
  tr.appendChild(tdCheck);

  const tdName = document.createElement('td');
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = item.baseName;
  const where = document.createElement('div');
  where.className = 'where';
  const dir = item.relPath.includes('/') ? item.relPath.slice(0, item.relPath.lastIndexOf('/') + 1) : './';
  where.textContent = [dir, item.note, fmtBytes(item.size)].filter(Boolean).join(' · ');
  tdName.append(name, where);
  tr.appendChild(tdName);

  const tdTarget = document.createElement('td');
  tdTarget.className = 'target';
  tdTarget.textContent = item.status === 'error' ? '—' : item.targetName;
  tr.appendChild(tdTarget);

  const tdStatus = document.createElement('td');
  const [cls, text] = BADGE[item.status] || ['unchanged', item.status];
  const badge = document.createElement('span');
  badge.className = `badge ${cls}`;
  badge.textContent = item.status === 'ok' && item.moves ? 'Renombra y mueve' : text;
  tdStatus.appendChild(badge);
  tr.appendChild(tdStatus);

  return tr;
}

function showBanner(kind, text, operationId) {
  const el = $('result-banner');
  el.className = `banner ${kind}`;
  el.classList.remove('hidden');
  el.innerHTML = '';
  const span = document.createElement('div');
  span.style.flex = '999 1 360px';
  span.textContent = text;
  el.appendChild(span);
  if (operationId) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.textContent = 'Deshacer todo';
    btn.addEventListener('click', () => undo(operationId));
    el.appendChild(btn);
  }
}

// ---------- acciones ----------

async function apply() {
  const items = selectedItems();
  if (items.length === 0) return;
  const moves = items.map((i) => ({ from: i.sourceAbs, to: i.targetAbs }));
  state.busy = true;
  $('apply').disabled = true;
  try {
    const res = await api('/api/apply', {
      method: 'POST',
      body: JSON.stringify({
        root: state.root,
        rule: { mode: state.mode, pattern: state.pattern, template: state.template },
        options: state.options,
        moves,
        emptyDirs: state.plan.emptyDirs,
      }),
    });
    state.lastOperation = res.operationId;
    const parts = [`${res.applied.length} archivos movidos`];
    if (res.removedDirs.length) parts.push(`${res.removedDirs.length} carpetas vacías eliminadas`);
    if (res.failures.length) parts.push(`${res.failures.length} fallaron`);
    showBanner(res.failures.length ? 'warn' : 'good', `Operación #${res.operationId}: ${parts.join(', ')}.`, res.operationId);
    if (res.failures.length) console.warn('fallos del apply', res.failures);
    state.deselected.clear();
    await loadPlan();
  } catch (err) {
    showBanner('bad', err.message, null);
  } finally {
    state.busy = false;
    render();
  }
}

async function undo(id) {
  try {
    const res = await api(`/api/undo/${id}`, { method: 'POST' });
    const parts = [`${res.restored} archivos regresados a su nombre original`];
    if (res.skipped.length) parts.push(`${res.skipped.length} omitidos porque ya habían cambiado`);
    if (res.failures.length) parts.push(`${res.failures.length} fallaron`);
    showBanner(res.failures.length ? 'warn' : 'good', `Deshecha la operación #${id}: ${parts.join(', ')}.`, null);
    if (res.skipped.length) console.warn('omitidos del undo', res.skipped);
    await loadPlan();
    if (!$('view-history').classList.contains('hidden')) loadHistory();
  } catch (err) {
    showBanner('bad', err.message, null);
  }
}

// ---------- selector de carpeta ----------

async function openPicker(startPath) {
  await browseTo(startPath || state.root || '');
  $('picker').showModal();
}

async function browseTo(p) {
  try {
    const res = await api(`/api/browse?path=${encodeURIComponent(p)}`);
    state.picker = res;
    $('picker-path').textContent = res.path;
    $('crumbs').innerHTML = '';
    const parts = res.path.split('/').filter(Boolean);
    let acc = '';
    parts.forEach((part, idx) => {
      acc += '/' + part;
      const isLast = idx === parts.length - 1;
      const el = document.createElement(isLast ? 'strong' : 'button');
      el.textContent = part;
      if (!isLast) {
        el.type = 'button';
        el.className = 'chip';
        el.style.border = '0';
        el.style.background = 'transparent';
        const target = acc;
        el.addEventListener('click', () => browseTo(target));
      }
      $('crumbs').appendChild(el);
      if (!isLast) {
        const sep = document.createElement('span');
        sep.textContent = '/';
        sep.style.color = 'var(--ink-faint)';
        $('crumbs').appendChild(sep);
      }
    });

    const list = $('picker-list');
    list.innerHTML = '';
    if (res.parent) {
      list.appendChild(pickerRow('⬅︎ Subir', '', () => browseTo(res.parent)));
    }
    for (const d of res.dirs) {
      const detail = [d.fileCount ? `${d.fileCount} archivos` : '', d.dirCount ? `${d.dirCount} carpetas` : '']
        .filter(Boolean)
        .join(' · ');
      list.appendChild(pickerRow(d.name, detail || 'vacía', () => browseTo(d.abs)));
    }
    if (res.dirs.length === 0) {
      const p = document.createElement('div');
      p.className = 'hint';
      p.style.padding = '16px 24px';
      p.textContent = `Sin subcarpetas. ${res.fileCount} archivos aquí.`;
      list.appendChild(p);
    }
  } catch (err) {
    showBanner('bad', err.message, null);
  }
}

function pickerRow(label, detail, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  const name = document.createElement('span');
  name.textContent = label;
  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = detail;
  btn.append(name, count);
  btn.addEventListener('click', onClick);
  return btn;
}

// ---------- reglas guardadas ----------

async function loadRules() {
  try {
    const { rules } = await api('/api/rules');
    const sel = $('saved-rules');
    sel.innerHTML = '<option value="">Reglas guardadas…</option>';
    for (const r of rules) {
      const opt = document.createElement('option');
      opt.value = String(r.id);
      opt.textContent = r.name;
      opt.dataset.mode = r.mode;
      opt.dataset.pattern = r.pattern;
      opt.dataset.template = r.template;
      sel.appendChild(opt);
    }
  } catch { /* sin reglas, no pasa nada */ }
}

// ---------- historial ----------

async function loadHistory() {
  const list = $('history-list');
  list.innerHTML = '<p class="spin">Cargando…</p>';
  try {
    const { operations } = await api('/api/history');
    list.innerHTML = '';
    if (operations.length === 0) {
      list.innerHTML = '<div class="empty">Todavía no has aplicado nada.</div>';
      return;
    }
    for (const op of operations) {
      const card = document.createElement('div');
      card.className = 'card op';
      const badges = [`<span class="badge ok">${op.moveCount} movidos</span>`];
      if (op.failureCount) badges.push(`<span class="badge error">${op.failureCount} fallaron</span>`);
      if (op.undoneAt) badges.push('<span class="badge unchanged">deshecha</span>');
      card.innerHTML = `
        <div class="meta">
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
            <strong>${op.root.split('/').pop() || op.root}</strong>
            ${badges.join('')}
          </div>
          <div class="path">${op.root}</div>
          <div class="hint">
            <span class="chip">${op.rule.mode === 'auto' ? 'automático' : op.rule.pattern}</span>
            →
            <span class="chip">${op.rule.template}</span>
            ${op.removedDirCount ? ` · ${op.removedDirCount} carpetas borradas` : ''}
          </div>
        </div>
        <div class="side">
          <span class="when">${fmtWhen(op.createdAt)} · #${op.id}</span>
        </div>`;
      if (!op.undoneAt && op.moveCount > 0) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn sm';
        btn.textContent = 'Deshacer';
        btn.addEventListener('click', () => undo(op.id));
        card.querySelector('.side').appendChild(btn);
      }
      list.appendChild(card);
    }
  } catch (err) {
    list.innerHTML = `<div class="banner bad">${err.message}</div>`;
  }
}

// ---------- arranque ----------

function showView(which) {
  $('view-rename').classList.toggle('hidden', which !== 'rename');
  $('view-history').classList.toggle('hidden', which !== 'history');
  $('nav-rename').setAttribute('aria-current', which === 'rename' ? 'page' : 'false');
  $('nav-history').setAttribute('aria-current', which === 'history' ? 'page' : 'false');
  if (which === 'history') loadHistory();
}

function wire() {
  $('host').textContent = location.host;

  $('root').addEventListener('input', (e) => {
    state.root = e.target.value;
    state.deselected.clear();
    schedulePlan();
  });
  $('pattern').addEventListener('input', (e) => {
    state.pattern = e.target.value;
    schedulePlan();
  });
  $('template').addEventListener('input', (e) => {
    state.template = e.target.value;
    schedulePlan();
  });

  for (const btn of $('modes').querySelectorAll('button')) {
    btn.addEventListener('click', () => {
      state.mode = btn.dataset.mode;
      for (const b of $('modes').querySelectorAll('button')) {
        b.setAttribute('aria-pressed', String(b === btn));
      }
      schedulePlan();
      render();
    });
  }

  for (const chip of document.querySelectorAll('[data-token]')) {
    chip.addEventListener('click', () => {
      const input = $('template');
      const pos = input.selectionStart ?? input.value.length;
      input.value = input.value.slice(0, pos) + chip.dataset.token + input.value.slice(pos);
      state.template = input.value;
      input.focus();
      schedulePlan();
    });
  }

  const opts = [
    ['opt-subfolders', 'includeSubfolders'],
    ['opt-flatten', 'flatten'],
    ['opt-rmdirs', 'deleteEmptyDirs'],
  ];
  for (const [id, key] of opts) {
    $(id).addEventListener('change', (e) => {
      state.options[key] = e.target.checked;
      schedulePlan();
    });
  }

  $('select-all').addEventListener('change', (e) => {
    if (!state.plan) return;
    if (e.target.checked) state.deselected.clear();
    else for (const i of state.plan.items) state.deselected.add(i.relPath);
    render();
  });

  $('recalc').addEventListener('click', loadPlan);
  $('apply').addEventListener('click', apply);
  $('browse').addEventListener('click', () => openPicker());
  $('browse-2').addEventListener('click', () => openPicker());
  $('picker-cancel').addEventListener('click', () => $('picker').close());
  $('picker-use').addEventListener('click', () => {
    state.root = state.picker.path;
    $('root').value = state.root;
    state.deselected.clear();
    $('picker').close();
    loadPlan();
  });

  $('saved-rules').addEventListener('change', (e) => {
    const opt = e.target.selectedOptions[0];
    if (!opt || !opt.value) return;
    state.mode = opt.dataset.mode;
    state.pattern = opt.dataset.pattern;
    state.template = opt.dataset.template;
    $('pattern').value = state.pattern;
    $('template').value = state.template;
    for (const b of $('modes').querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
    }
    loadPlan();
  });

  $('save-rule').addEventListener('click', async () => {
    const name = prompt('Nombre de la regla', state.mode === 'auto' ? 'Automático' : state.pattern);
    if (!name) return;
    try {
      await api('/api/rules', {
        method: 'POST',
        body: JSON.stringify({
          name,
          rule: { mode: state.mode, pattern: state.pattern, template: state.template },
        }),
      });
      await loadRules();
    } catch (err) {
      showBanner('bad', err.message, null);
    }
  });

  $('nav-rename').addEventListener('click', () => showView('rename'));
  $('nav-history').addEventListener('click', () => showView('history'));
}

async function boot() {
  wire();
  $('pattern').value = state.pattern;
  await loadRules();
  try {
    const { recent, roots } = await api('/api/roots');
    const start = (recent[0] && recent[0].root) || '';
    if (start) {
      state.root = start;
      $('root').value = start;
      await loadPlan();
    } else if (roots.length) {
      $('root').placeholder = `${roots[0]}/…`;
    }
  } catch (err) {
    showBanner('bad', err.message, null);
  }
  render();
}

boot();
