// Spotlight — service worker.
// Routes the keyboard command, the page right-click menu item and popup
// requests to the content script in the active tab, injecting it on demand,
// and keeps the toolbar badge and the menu item's tick in sync.

const MENU_ID = 'toggle-spotlight';

// Re-inject into tabs that were already open, so a reloaded extension replaces
// the stale content script (and its on-page overlay) right away instead of
// waiting for the tab to navigate. Tabs that can't be scripted are skipped.
async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(async (tab) => {
    if (tab.id == null || /^(chrome|edge|about|devtools|chrome-extension|chrome-untrusted):/i.test(tab.url || '')) return;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    } catch {
      // no host access to this tab; it will be injected on demand instead
    }
  }));
}

// One plain item, so Chrome shows it directly in the page's right-click menu
// (it only nests an extension's items in a submenu when there are several).
// Items persist across service-worker restarts; recreate on install/reload,
// clearing first so an older version's item can't linger.
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: MENU_ID, title: 'Spotlight', contexts: ['all'] });
  injectIntoOpenTabs();
});
chrome.runtime.onStartup.addListener(injectIntoOpenTabs);

// Send a message to the content script. Tabs that were already open when the
// extension was installed/reloaded have no content script yet, so inject it
// and retry once. Returns the content script's state, or null if the page
// can't be scripted (chrome://, Chrome Web Store, PDF viewer, ...).
async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (err) {
      console.warn('Spotlight unavailable on this tab:', err?.message);
      return null;
    }
  }
}

function updateBadge(tabId, state) {
  chrome.action.setBadgeText({ tabId, text: state?.spotlight ? 'ON' : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#7553FF' }).catch(() => {});
  syncMenu(tabId, state);
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
      if (state) updateBadge(msg.tabId, state);
      sendResponse(state);
    });
    return true; // keep the channel open for the async response
  }
});
