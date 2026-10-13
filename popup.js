// Spotlight — popup.

const DEFAULTS = {
  shape: 'circle',
  width: 280,
  height: 180,
  effect: 'dim',
  intensity: 70,
  autoZoomResize: true,
  autoZoomPlace: false,
  inkColor: '#fd44b0',
};

const $ = (id) => document.getElementById(id);
let tabId = null;
let settings = { ...DEFAULTS };
let viewport = null; // the tab's viewport, so size sliders can reach full screen

const SLIDERS = {
  width: (v) => `${v}`,
  height: (v) => `${v}`,
  intensity: (v) => `${v}%`,
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

// ------------------------------------------------------------------ cues

async function renderCues() {
  const info = await sendToTab({ action: 'pageCues' });
  const list = $('cueList');
  list.textContent = '';
  if (!info?.cues?.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = info ? 'No cues on this page' : 'Cues aren’t available here';
    list.append(li);
    return;
  }
  for (const cue of info.cues) {
    const li = document.createElement('li');
    li.classList.toggle('off', !cue.enabled);
    const name = document.createElement('span');
    name.textContent = cue.name;
    name.title = cue.name;
    const test = document.createElement('button');
    test.className = 'btn';
    test.textContent = 'Test';
    test.title = 'Show this cue’s spotlight now';
    test.addEventListener('click', async () => {
      await sendToTab({ action: 'testCue', id: cue.id });
      window.close();
    });
    li.append(name, test);
    list.append(li);
  }
}

function renderArmed(armed, key) {
  $('cuesArmed').checked = armed;
  $('cuesStatus').innerHTML = '';
  const kbd = document.createElement('kbd');
  kbd.textContent = key || 'no shortcut';
  $('cuesStatus').append(armed ? 'Armed · ' : 'Off · ', kbd, armed ? ' to disarm' : ' to arm');
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
  $('sizes').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const win = await chrome.windows.getCurrent();
    await chrome.runtime.sendMessage({ type: 'resizeWindow', windowId: win.id, size: btn.dataset.size });
    setTimeout(renderViewport, 200); // the page reports its new size after its resize event
  });
  renderCues();
  renderViewport();
}

init();
