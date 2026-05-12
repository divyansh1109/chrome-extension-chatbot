/**
 * Thin background service worker — tab lifecycle + panel toggle.
 * All chat logic, history, and UI live on the backend now.
 */

const API_BASE = "https://chrome-extension-chatbot-production.up.railway.app";
// const API_BASE = "http://127.0.0.1:8765";

// ── Helper: call backend ─────────────────────────────────────

async function api(path, options = {}) {
  const resp = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.detail || `API error ${resp.status}`);
  }
  return resp.json();
}

// ── Track which tab has the panel open (single-instance) ─────

let activePanelTabId = null;

// ── Icon click → init session + toggle panel ─────────────────

chrome.action.onClicked.addListener(async (tab) => {
  try {
    // If panel is already open on another tab, focus that tab instead
    if (activePanelTabId !== null && activePanelTabId !== tab.id) {
      try {
        const existingTab = await chrome.tabs.get(activePanelTabId);
        if (existingTab) {
          await chrome.tabs.update(activePanelTabId, { active: true });
          await chrome.windows.update(existingTab.windowId, { focused: true });
          return;
        }
      } catch {
        // Tab no longer exists, clear the tracker
        activePanelTabId = null;
      }
    }

    // Extract page content via content script
    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_PAGE_CONTENT" });
    } catch {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      response = await chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_PAGE_CONTENT" });
    }

    if (!response || !response.success) throw new Error("Failed to extract page content.");

    // Create session on the backend
    const session = await api("/session", {
      method: "POST",
      body: JSON.stringify(response.data),
    });

    // Register tab in the backend's tab registry
    await api(`/tabs/${tab.id}`, {
      method: "POST",
      body: JSON.stringify({
        session_id: session.session_id,
        url: session.url,
        title: session.title,
      }),
    }).catch(() => {});

    // Toggle panel with the session ID
    await chrome.tabs.sendMessage(tab.id, {
      type: "TOGGLE_PANEL",
      sessionId: session.session_id,
    });

    // Track which tab has the panel (toggle: open ↔ close)
    activePanelTabId = activePanelTabId === tab.id ? null : tab.id;

    // Register all other open tabs (unindexed) so they appear in multi-tab selector
    const allTabs = await chrome.tabs.query({});
    for (const t of allTabs) {
      if (t.id === tab.id) continue;
      if (!t.url || t.url.startsWith("chrome://") || t.url.startsWith("chrome-extension://")) continue;
      api(`/tabs/${t.id}`, {
        method: "POST",
        body: JSON.stringify({ url: t.url, title: t.title || t.url }),
      }).catch(() => {});
    }
    broadcastToAllPanels({ type: "TABS_CHANGED" });
  } catch (err) {
    console.error("Failed to init:", err);
  }
});

// ── Tab closed → cleanup ─────────────────────────────────────

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === activePanelTabId) activePanelTabId = null;
  api(`/tabs/${tabId}`, { method: "DELETE" }).catch(() => {});
  broadcastToAllPanels({ type: "TABS_CHANGED" });
});

// ── New tab created → register as unindexed ──────────────────

chrome.tabs.onCreated.addListener(async (tab) => {
  // New tabs may not have a URL yet; register once they do via onUpdated
});

// ── Tab navigated → register + notify panels ─────────────────

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) return;
  // Register/update the tab on the server (unindexed if no session exists yet)
  api(`/tabs/${tabId}`, {
    method: "POST",
    body: JSON.stringify({ url: tab.url, title: tab.title || tab.url }),
  }).catch(() => {});
  broadcastToAllPanels({ type: "TABS_CHANGED" });
});

// ── Handle messages from content script ──────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PANEL_CLOSED" && sender.tab) {
    if (sender.tab.id === activePanelTabId) activePanelTabId = null;
    return false;
  }

  if (message.type === "RESET_SESSION" && sender.tab) {
    (async () => {
      try {
        const tabId = sender.tab.id;
        const response = await chrome.tabs.sendMessage(tabId, { type: "EXTRACT_PAGE_CONTENT" });
        if (!response || !response.success) throw new Error("Extract failed");

        const session = await api("/session", {
          method: "POST",
          body: JSON.stringify(response.data),
        });
        await api(`/tabs/${tabId}`, {
          method: "POST",
          body: JSON.stringify({
            session_id: session.session_id,
            url: session.url,
            title: session.title,
          }),
        }).catch(() => {});

        sendResponse({ success: true, sessionId: session.session_id });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // keep channel open for async response
  }

  if (message.type === "INDEX_TAB") {
    (async () => {
      try {
        const targetTabId = message.tabId;
        let response;
        try {
          response = await chrome.tabs.sendMessage(targetTabId, { type: "EXTRACT_PAGE_CONTENT" });
        } catch {
          await chrome.scripting.executeScript({ target: { tabId: targetTabId }, files: ["content.js"] });
          response = await chrome.tabs.sendMessage(targetTabId, { type: "EXTRACT_PAGE_CONTENT" });
        }
        if (!response || !response.success) throw new Error("Extract failed");

        const session = await api("/session", {
          method: "POST",
          body: JSON.stringify(response.data),
        });
        await api(`/tabs/${targetTabId}`, {
          method: "POST",
          body: JSON.stringify({
            session_id: session.session_id,
            url: session.url,
            title: session.title,
          }),
        });
        broadcastToAllPanels({ type: "TABS_CHANGED" });
        sendResponse({ success: true, sessionId: session.session_id });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.type === "PAGE_CONTENT_CHANGED" && sender.tab) {
    (async () => {
      try {
        const tabId = sender.tab.id;
        const response = await chrome.tabs.sendMessage(tabId, { type: "EXTRACT_PAGE_CONTENT" });
        if (!response || !response.success) return;

        const session = await api("/session", {
          method: "POST",
          body: JSON.stringify(response.data),
        });
        await api(`/tabs/${tabId}`, {
          method: "POST",
          body: JSON.stringify({
            session_id: session.session_id,
            url: session.url,
            title: session.title,
          }),
        }).catch(() => {});
      } catch { /* ignore */ }
    })();
    return false;
  }
});

async function broadcastToAllPanels(message) {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    chrome.tabs.sendMessage(t.id, message).catch(() => {});
  }
}
