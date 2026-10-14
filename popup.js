// Spotlight — popup.

const DEFAULTS = {
  shape: 'circle',
  width: 280,
  height: 180,
  effect: 'dim',
  strength: 100,
  autoZoomResize: true,
  autoZoomPlace: false,
  inkColor: '#fd44b0',
  blockOutside: false,
  closeOnOutside: false,
};

const $ = (id) => document.getElementById(id);
let tabId = null;
let settings = { ...DEFAULTS };
let viewport = null; // the tab's viewport, so size sliders can reach full screen

const SLIDERS = {
  width: (v) => `${v}`,
  height: (v) => `${v}`,
  strength: (v) => `${v}%`,
};

function save(patch) {
  Object.assign(settings, patch);
  chrome.storage.local.set(patch); // the content script listens and updates live
  syncVisibility();
}

function sendToTab(payload) {
  if (tabId == null) return Promise.resolve(null);
  return chrome.runtime.sendMessage({ type: 'relay', tabId, payload }).catch(() => null);
}

function renderState(state) {
  document.body.classList.toggle('unavailable', !state);
  if (!state) {
    $('status').textContent = 'Not available on this page';
    return;
  }
  $('spotlight').checked = state.spotlight;
  if (state.viewport) {
    viewport = state.viewport;
    syncVisibility();
  }
  $('status').textContent = !state.spotlight ? 'Off' : state.pinned ? 'Placed' : 'Following cursor';
}

function setSliderMax(key, max) {
  const input = $(key);
  input.max = Math.ceil(max / 10) * 10;
  input.value = settings[key]; // re-apply so the thumb lands right under the new max
}

// Show only the controls that apply to the current shape/effect.
function syncVisibility() {
  const circle = settings.shape === 'circle';
  $('widthLabel').textContent = circle ? 'Size' : 'Width';
  $('heightRow').hidden = circle;
  if (viewport) {
    const longest = Math.max(viewport.w, viewport.h);
    setSliderMax('width', circle ? longest : viewport.w);
    setSliderMax('height', viewport.h);
  }
  for (const group of document.querySelectorAll('[data-setting]')) {
    const key = group.dataset.setting;
    for (const btn of group.querySelectorAll('button')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.value === settings[key]));
    }
  }
  // A custom ink colour (not one of the swatches) lights up the picker.
  const custom = $('inkCustom');
  custom.value = settings.inkColor;
  const isSwatch = [...document.querySelectorAll('[data-setting="inkColor"] button')].some((b) => b.dataset.value === settings.inkColor);
  custom.parentElement.setAttribute('aria-pressed', String(!isSwatch));
  // Independent on/off toggles (each button is its own boolean setting).
  for (const btn of document.querySelectorAll('button[data-toggle]')) {
    btn.setAttribute('aria-pressed', String(!!settings[btn.dataset.toggle]));
  }
}

async function init() {
  initTabs();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  settings = await chrome.storage.local.get(DEFAULTS);
  // Older versions offered more shapes/effects; show their nearest match.
  if (!['circle', 'rounded'].includes(settings.shape)) settings.shape = settings.shape === 'ellipse' ? 'circle' : 'rounded';
  if (!['dim', 'blur', 'blur-dim'].includes(settings.effect)) settings.effect = 'dim';

  for (const [key, format] of Object.entries(SLIDERS)) {
    const input = $(key);
    const out = $(`${key}Out`);
    input.value = settings[key];
    out.textContent = format(settings[key]);
    input.addEventListener('input', () => {
      const value = Number(input.value);
      out.textContent = format(value);
      save({ [key]: value });
    });
  }

  $('inkCustom').addEventListener('input', (e) => save({ inkColor: e.target.value }));

  for (const btn of document.querySelectorAll('button[data-toggle]')) {
    btn.addEventListener('click', () => save({ [btn.dataset.toggle]: !settings[btn.dataset.toggle] }));
  }

  for (const group of document.querySelectorAll('[data-setting]')) {
    group.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (btn) save({ [group.dataset.setting]: btn.dataset.value });
    });
  }
  syncVisibility();

  $('spotlight').addEventListener('change', async (e) => {
    renderState(await sendToTab({ action: 'setSpotlight', value: e.target.checked }));
  });

  // Show the shortcut actually bound in this browser (users can rebind it).
  const commands = await chrome.commands.getAll();
  const toggle = commands.find((c) => c.name === 'toggle-spotlight');
  $('toggleKey').textContent = toggle?.shortcut || 'No shortcut';
  $('editShortcuts').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  renderState(await sendToTab({ action: 'getState' }));
  initCues(commands.find((c) => c.name === 'toggle-cues'));
}

// ------------------------------------------------------------------ tabs

const TAB_KEY = 'popupTab'; // remembered per viewer: which tab the popup opens on

function showTab(name) {
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    const on = tab.id === `tab-${name}`;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $(tab.getAttribute('aria-controls')).hidden = !on;
  }
  try { localStorage.setItem(TAB_KEY, name); } catch { /* storage blocked */ }
}

function initTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  for (const tab of tabs) {
    tab.addEventListener('click', () => showTab(tab.id.slice(4)));
    // Arrow keys move between tabs.
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const next = tabs[(tabs.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      showTab(next.id.slice(4));
      next.focus();
    });
  }
  let saved = 'spotlight';
  try { saved = localStorage.getItem(TAB_KEY) || saved; } catch { /* storage blocked */ }
  showTab(saved === 'cues' ? 'cues' : 'spotlight');
}

// ------------------------------------------------------------------ cues

let pageCueIds = null; // ids of the cues that match this tab's page (null: can't run here)
let showAll = false;
let previewId = null;  // the cue whose spotlight was last tested, refreshed as it's edited
let previewTimer = 0;
const openIds = new Set(); // editors left open survive a re-render

function preview(cue) {
  previewId = cue.id;
  sendToTab({ action: 'testCue', id: cue.id, cue });
}

// Edits to the cue being previewed show on the page right away.
function onCueChanged(cue) {
  if (cue.id !== previewId) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => preview(cue), 250);
}

async function renderCues() {
  const all = await CueStore.all();
  const onPage = pageCueIds ? all.filter((c) => pageCueIds.includes(c.id)) : [];
  const list = showAll ? all : onPage;
  const others = all.length - onPage.length;
  $('listTitle').textContent = showAll ? `All cues (${all.length})` : `On this page (${onPage.length})`;
  $('showAll').hidden = !others && !showAll;
  $('showAll').textContent = showAll ? 'This page only' : `Show all (${all.length})`;

  const box = $('cueList');
  for (const ed of box.querySelectorAll('details[open]')) openIds.add(ed.dataset.id);
  box.textContent = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = pageCueIds ? 'No cues on this page yet' : 'Cues can’t run on this page';
    box.append(empty);
    return;
  }
  for (const cue of list) {
    const onThisPage = pageCueIds?.includes(cue.id);
    const ed = CueEditor.create(cue, {
      // Testing and redrawing need the cue's page; measuring needs its anchor.
      test: onThisPage ? preview : null,
      redraw: onThisPage ? async (c) => { await sendToTab({ action: 'redrawCue', id: c.id }); window.close(); } : null,
      measure: onThisPage ? (c) => sendToTab({ action: 'cueGeometry', id: c.id, cue: c }) : null,
      pick: onThisPage ? async (c, what, index) => { await sendToTab({ action: 'pickCueElement', id: c.id, what, index }); window.close(); } : null,
      check: onThisPage ? (element) => sendToTab({ action: 'checkElement', element }) : null,
      changed: onCueChanged,
      deleted: () => renderCues(),
    });
    ed.dataset.id = cue.id;
    ed.open = openIds.has(cue.id) || list.length === 1;
    ed.addEventListener('toggle', () => { if (ed.open) openIds.add(cue.id); else openIds.delete(cue.id); });
    box.append(ed);
  }
}

function renderArmed(armed, key) {
  $('cuesArmed').checked = armed;
  $('armedPill').hidden = !armed;
  const status = $('cuesStatus');
  status.textContent = '';
  const kbd = document.createElement('kbd');
  kbd.textContent = key || 'no shortcut';
  status.append(armed ? 'Armed · ' : 'Off · ', kbd, armed ? ' to disarm' : ' to arm');
}

async function renderViewport() {
  const state = await sendToTab({ action: 'getState' });
  $('viewport').textContent = state?.viewport ? `Page area ${state.viewport.w} × ${state.viewport.h}` : '';
  const win = await chrome.windows.getCurrent();
  $('restoreSize').hidden = !(await chrome.runtime.sendMessage({ type: 'hasSavedBounds', windowId: win.id }));
}

async function initCues(cuesCommand) {
  const key = cuesCommand?.shortcut;
  renderArmed(await chrome.runtime.sendMessage({ type: 'getCuesArmed' }), key);
  $('cuesArmed').addEventListener('change', async (e) => {
    renderArmed(await chrome.runtime.sendMessage({ type: 'setCuesArmed', value: e.target.checked }), key);
  });
  $('recordCue').addEventListener('click', async () => {
    await sendToTab({ action: 'recordCue' });
    window.close();
  });
  $('manageCues').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  $('showAll').addEventListener('click', () => {
    showAll = !showAll;
    renderCues();
  });
  $('sizes').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const win = await chrome.windows.getCurrent();
    await chrome.runtime.sendMessage({ type: 'resizeWindow', windowId: win.id, size: btn.dataset.size });
    setTimeout(renderViewport, 200); // the page reports its new size after its resize event
  });
  // Cues recorded or edited elsewhere (another popup, the manager) show up
  // here; our own edits don't re-render, so open editors keep their focus.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.cues) return;
    const ids = (list) => (list || []).map((c) => c.id).join();
    if (ids(changes.cues.newValue) !== ids(changes.cues.oldValue)) renderCues();
  });
  const info = await sendToTab({ action: 'pageCues' });
  pageCueIds = info ? info.cues.map((c) => c.id) : null;
  renderCues();
  renderViewport();
}

init();
