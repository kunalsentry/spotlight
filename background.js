// Spotlight — service worker.
// Routes the keyboard command, the page right-click menu item and popup
// requests to the content script in the active tab, injecting it on demand,
// and keeps the toolbar badge and the menu item's tick in sync. It also owns
// whether cues are armed (kept in session storage, so every browser session
// starts unarmed) and resizes the window for testing cues at other sizes.

const MENU_ID = 'toggle-spotlight';
const CONTENT_SCRIPTS = ['content.js', 'cues.js'];
const ON_COLOR = '#7553FF';  // blurple: spotlight on in this tab
const CUE_COLOR = '#FD44B0'; // pink: cues armed

const getArmed = async () => !!(await chrome.storage.session.get({ cuesArmed: false })).cuesArmed;

// One plain item, so Chrome shows it directly in the page's right-click menu
// (it only nests an extension's items in a submenu when there are several).
// Items persist across service-worker restarts; recreate on install/reload,
// clearing first so an older version's item can't linger.
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: MENU_ID, title: 'Spotlight', contexts: ['all'] });
});

// Send a message to the content script. Tabs that were already open when the
// extension was installed/reloaded have no content script yet, so inject it
// and retry once. Returns the content script's state, or null if the page
// can't be scripted (chrome://, Chrome Web Store, PDF viewer, ...).
async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPTS });
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (err) {
      console.warn('Spotlight unavailable on this tab:', err?.message);
      return null;
    }
  }
}

// ON while this tab's spotlight is on; otherwise CUE while cues are armed.
async function updateBadge(tabId, state) {
  const armed = await getArmed();
  const text = state?.spotlight ? 'ON' : armed ? 'CUE' : '';
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: state?.spotlight ? ON_COLOR : CUE_COLOR }).catch(() => {});
  syncMenu(tabId, state);
}

// Arm or disarm cues everywhere: the default badge (tabs we haven't
// talked to), and every tab's content script, which answers with its state
// so its own badge can be updated too.
async function setArmed(armed) {
  await chrome.storage.session.set({ cuesArmed: armed });
  chrome.action.setBadgeText({ text: armed ? 'CUE' : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: CUE_COLOR }).catch(() => {});
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(async (tab) => {
    const state = await chrome.tabs.sendMessage(tab.id, { action: 'cuesArmed', value: armed }).catch(() => null);
    if (state) updateBadge(tab.id, state);
    else chrome.action.setBadgeText({ tabId: tab.id, text: armed ? 'CUE' : '' }).catch(() => {});
  }));
  return armed;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resize a window to test cues at another size ("1440x900"), remembering its
// original size and state the first time; "restore" puts it back.
async function resizeWindow(windowId, size) {
  const key = `bounds:${windowId}`;
  const saved = (await chrome.storage.session.get(key))[key];
  if (size === 'restore') {
    if (!saved) return;
    await chrome.storage.session.remove(key);
    if (saved.state === 'normal') {
      const { left, top, width, height } = saved;
      await chrome.windows.update(windowId, { left, top, width, height });
    } else {
      await chrome.windows.update(windowId, { state: saved.state });
    }
    return;
  }
  const [width, height] = size.split('x').map(Number);
  const win = await chrome.windows.get(windowId);
  if (!saved) {
    const { state, left, top, width: w, height: h } = win;
    await chrome.storage.session.set({ [key]: { state, left, top, width: w, height: h } });
  }
  if (win.state !== 'normal') {
    await chrome.windows.update(windowId, { state: 'normal' });
    await sleep(win.state === 'fullscreen' ? 900 : 300); // let macOS finish leaving fullscreen
  }
  await chrome.windows.update(windowId, { width, height });
}

// The menu item is shared by all tabs, so its label follows the active tab.
async function syncMenu(tabId, state) {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.id !== tabId) return;
  const title = state?.spotlight ? 'Turn off spotlight' : 'Spotlight';
  chrome.contextMenus.update(MENU_ID, { title }).catch(() => {});
}

async function refreshMenuFor(tabId) {
  // Ask without injecting: a tab with no content script has no spotlight on.
  const state = await chrome.tabs.sendMessage(tabId, { action: 'getState' }).catch(() => null);
  syncMenu(tabId, state);
}

chrome.tabs.onActivated.addListener(({ tabId }) => refreshMenuFor(tabId));
chrome.windows.onFocusChanged.addListener(async () => {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.id != null) refreshMenuFor(active.id);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || tab?.id == null) return;
  const state = await sendToTab(tab.id, { action: 'toggleSpotlight' });
  updateBadge(tab.id, state);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'toggle-cues') {
    setArmed(!(await getArmed()));
    return;
  }
  if (command !== 'toggle-spotlight') return;
  const target = tab?.id != null ? tab : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!target?.id) return;
  const state = await sendToTab(target.id, { action: 'toggleSpotlight' });
  if (state) updateBadge(target.id, state);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Content script reporting a state change (e.g. user pressed Escape).
  if (msg?.type === 'state' && sender.tab?.id != null) {
    updateBadge(sender.tab.id, msg.state);
    return;
  }
  // Popup asking us to talk to a tab on its behalf.
  if (msg?.type === 'relay' && msg.tabId != null) {
    sendToTab(msg.tabId, msg.payload).then((state) => {
      if (state && 'spotlight' in state) updateBadge(msg.tabId, state);
      sendResponse(state);
    });
    return true; // keep the channel open for the async response
  }
  if (msg?.type === 'getCuesArmed') {
    getArmed().then(sendResponse);
    return true;
  }
  if (msg?.type === 'setCuesArmed') {
    setArmed(!!msg.value).then(sendResponse);
    return true;
  }
  if (msg?.type === 'resizeWindow' && msg.windowId != null) {
    resizeWindow(msg.windowId, msg.size).then(() => sendResponse(true), () => sendResponse(false));
    return true;
  }
  if (msg?.type === 'hasSavedBounds' && msg.windowId != null) {
    const key = `bounds:${msg.windowId}`;
    chrome.storage.session.get(key).then((v) => sendResponse(!!v[key]));
    return true;
  }
});
