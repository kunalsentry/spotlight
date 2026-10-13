// Spotlight — cue manager (options page).

const $ = (id) => document.getElementById(id);
let cues = [];
let written = ''; // the last list we saved, so our own writes don't re-render

// How one axis is placed; `edges` names its start and end edges.
const RULES = {
  stretch: (r) => `follows its edges (${fmt(r.a)} / ${fmt(r.b)})`,
  start: (r, edges) => `${r.size}px, ${r.inset}px from the ${edges[0]}`,
  end: (r, edges) => `${r.size}px, ${r.inset}px from the ${edges[1]}`,
  center: (r) => `${r.size}px, centred${r.offset ? ` (${fmt(r.offset)})` : ''}`,
};
const fmt = (n) => `${n > 0 ? '+' : ''}${n}px`;

function validPattern(page) {
  try {
    new URLPattern({ hostname: page.hostname || '*', pathname: (page.pathname || '/').replace(/\/+$/, '') + '{/}?' });
    return true;
  } catch {
    return false;
  }
}

function describeArea(sp) {
  const target = sp.anchor ? `“${sp.anchorName || 'element'}”` : 'the window';
  if (sp.x.pin === 'stretch' && sp.y.pin === 'stretch') {
    const pads = [-sp.y.a, -sp.x.b, -sp.y.b, -sp.x.a];
    const same = pads.every((p) => p === pads[0]);
    return `Fits ${target}, padding ${same ? `${pads[0]}px` : pads.map((p) => `${p}px`).join(' ')}`;
  }
  return `In ${target}: width ${RULES[sp.x.pin](sp.x, ['left', 'right'])}; height ${RULES[sp.y.pin](sp.y, ['top', 'bottom'])}`;
}

const describeTrigger = (fp) => fp.map((s) => s.name ? `${s.kind} “${s.name}”` : `${s.kind} <code>${escape(s.sel)}</code>`).join(', then ');

function escape(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function save() {
  written = JSON.stringify(cues);
  await chrome.storage.local.set({ cues });
}

function update(id, fn) {
  const cue = cues.find((c) => c.id === id);
  if (!cue) return;
  fn(cue);
  save();
}

function cueCard(cue) {
  const el = document.createElement('section');
  el.className = 'cue';
  el.classList.toggle('off', !cue.enabled);
  el.innerHTML = `
    <div class="cue-head">
      <input type="checkbox" class="enabled" title="Enabled" aria-label="Enabled">
      <input type="text" class="name" aria-label="Name">
      <button class="danger delete">Delete</button>
    </div>
    <div class="grid">
      <span>Page</span>
      <div>
        <div class="url">
          <input type="text" class="host" aria-label="Host name" placeholder="any host">
          <input type="text" class="path" aria-label="Path pattern">
        </div>
        <div class="error" hidden>Not a valid pattern. Use <code>:name</code> for one path segment and <code>*</code> for anything.</div>
      </div>
      <span>Trigger</span>
      <div class="detail">Click, found by ${describeTrigger(cue.trigger.element)}</div>
      <span>Spotlight</span>
      <div class="detail">${escape(describeArea(cue.spotlight))} · ${cue.spotlight.shape === 'circle' ? 'circle' : 'box'}</div>
      <span>Options</span>
      <div class="toggles">
        <label class="check"><input type="checkbox" class="zoom"> Zoom in</label>
        <label class="check"><input type="checkbox" class="scroll"> Scroll into view</label>
      </div>
    </div>`;
  const q = (sel) => el.querySelector(sel);
  q('.enabled').checked = cue.enabled;
  q('.name').value = cue.name;
  q('.host').value = cue.page.hostname;
  q('.path').value = cue.page.pathname;
  q('.zoom').checked = !!cue.spotlight.zoom;
  q('.scroll').checked = cue.spotlight.scroll !== false;

  q('.enabled').addEventListener('change', (e) => {
    el.classList.toggle('off', !e.target.checked);
    update(cue.id, (c) => { c.enabled = e.target.checked; });
  });
  q('.name').addEventListener('change', (e) => update(cue.id, (c) => { c.name = e.target.value.trim() || c.name; }));
  q('.zoom').addEventListener('change', (e) => update(cue.id, (c) => { c.spotlight.zoom = e.target.checked; }));
  q('.scroll').addEventListener('change', (e) => update(cue.id, (c) => { c.spotlight.scroll = e.target.checked; }));
  // Patterns save only once valid; an invalid one is flagged while typing.
  const onPage = (commit) => {
    const page = { hostname: q('.host').value.trim(), pathname: q('.path').value.trim() || '/' };
    const ok = validPattern(page);
    q('.error').hidden = ok;
    q('.path').classList.toggle('invalid', !ok);
    if (ok && commit) update(cue.id, (c) => { c.page = page; });
  };
  for (const input of [q('.host'), q('.path')]) {
    input.addEventListener('input', () => onPage(false));
    input.addEventListener('change', () => onPage(true));
  }
  q('.delete').addEventListener('click', () => {
    if (!confirm(`Delete “${cue.name}”?`)) return;
    cues = cues.filter((c) => c.id !== cue.id);
    save();
    render();
  });
  return el;
}

function render() {
  const list = $('list');
  list.textContent = '';
  if (!cues.length) {
    list.innerHTML = '<div class="empty">No cues yet. Open the Spotlight popup on a page and click <b>Record cue</b>.</div>';
    return;
  }
  // Grouped by site.
  const groups = new Map();
  for (const cue of cues) {
    const host = cue.page.hostname || 'Any site';
    if (!groups.has(host)) groups.set(host, []);
    groups.get(host).push(cue);
  }
  for (const [host, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const h = document.createElement('h2');
    h.textContent = host;
    list.append(h, ...group.map(cueCard));
  }
}

function say(text) {
  $('message').textContent = text;
  setTimeout(() => { if ($('message').textContent === text) $('message').textContent = ''; }, 4000);
}

const isCue = (c) => c && typeof c.id === 'string' && c.page && c.trigger?.element?.length && c.spotlight?.x && c.spotlight?.y;

$('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ spotlightCues: 1, cues }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `spotlight-cues-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// Imported cues replace ones with the same id, and are added otherwise.
$('import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const incoming = (Array.isArray(data) ? data : data.cues || []).filter(isCue);
    if (!incoming.length) throw new Error('no cues');
    const byId = new Map(cues.map((c) => [c.id, c]));
    for (const cue of incoming) byId.set(cue.id, cue);
    cues = [...byId.values()];
    await save();
    render();
    say(`Imported ${incoming.length} cue${incoming.length === 1 ? '' : 's'}.`);
  } catch {
    say('That file doesn’t contain any Spotlight cues.');
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.cues) return;
  const next = changes.cues.newValue || [];
  if (JSON.stringify(next) === written) return;
  cues = next;
  render();
});

chrome.storage.local.get({ cues: [] }).then(({ cues: list }) => {
  cues = list;
  written = JSON.stringify(cues);
  render();
});
