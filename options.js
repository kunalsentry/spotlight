// Spotlight — cue manager (options page). Each cue is edited with the same
// editor as the popup's Cues tab (cue-editor.js). Testing and redrawing need
// the cue's page, so they're only in the popup.

const $ = (id) => document.getElementById(id);
const openIds = new Set(); // editors left open survive a re-render

async function render() {
  const cues = await CueStore.all();
  const list = $('list');
  for (const ed of list.querySelectorAll('details[open]')) openIds.add(ed.dataset.id);
  list.textContent = '';
  if (!cues.length) {
    list.innerHTML = '<div class="empty">No cues yet. Open the Spotlight popup on a page, go to <b>Cues</b> and click <b>Record cue</b>.</div>';
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
    list.append(h);
    for (const cue of group) {
      const ed = CueEditor.create(cue, { deleted: render });
      ed.dataset.id = cue.id;
      ed.open = openIds.has(cue.id);
      ed.addEventListener('toggle', () => { if (ed.open) openIds.add(cue.id); else openIds.delete(cue.id); });
      list.append(ed);
    }
  }
}

function say(text) {
  $('message').textContent = text;
  setTimeout(() => { if ($('message').textContent === text) $('message').textContent = ''; }, 4000);
}

$('export').addEventListener('click', async () => {
  const blob = new Blob([JSON.stringify({ spotlightCues: 1, cues: await CueStore.all() }, null, 2)], { type: 'application/json' });
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
    const incoming = (Array.isArray(data) ? data : data.cues || []).filter(CueEditor.isCue);
    if (!incoming.length) throw new Error('no cues');
    await CueStore.add(incoming);
    say(`Imported ${incoming.length} cue${incoming.length === 1 ? '' : 's'}.`);
  } catch {
    say('That file doesn’t contain any Spotlight cues.');
  }
});

// Re-render when cues are added or removed elsewhere (recorded, imported,
// deleted in the popup), but not for edits, so an editor keeps its focus.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.cues) return;
  const ids = (list) => (list || []).map((c) => c.id).join();
  if (ids(changes.cues.newValue) !== ids(changes.cues.oldValue)) render();
});

render();
