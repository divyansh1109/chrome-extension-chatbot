/**
 * Background service worker for the Webpage Chatbot extension.
 * Manages communication between the panel (iframe), content script, and backend.
 * Sessions are persisted in chrome.storage.session to survive SW restarts.
 */

const API_BASE = "https://chrome-extension-chatbot-production.up.railway.app";

// ── Session storage helpers (survive SW idle restarts) ────────

async function loadSessions() {
  const data = await chrome.storage.session.get("tabSessions");
  return data.tabSessions || {};
}

async function saveSessions(sessions) {
  await chrome.storage.session.set({ tabSessions: sessions });
}

async function getTabSession(tabId) {
  const sessions = await loadSessions();
  return sessions[tabId] || null;
}

async function setTabSession(tabId, session) {
  const sessions = await loadSessions();
  sessions[tabId] = session;
  await saveSessions(sessions);
}

async function removeTabSession(tabId) {
  const sessions = await loadSessions();
  delete sessions[tabId];
  await saveSessions(sessions);
}

// ── Chat history storage (survive panel close/reopen) ────────

async function loadChatHistory(tabId) {
  const data = await chrome.storage.session.get("chatHistory");
  const all = data.chatHistory || {};
  return all[tabId] || [];
}

async function saveChatHistory(tabId, messages) {
  const data = await chrome.storage.session.get("chatHistory");
  const all = data.chatHistory || {};
  all[tabId] = messages;
  await chrome.storage.session.set({ chatHistory: all });
}

async function clearChatHistory(tabId) {
  const data = await chrome.storage.session.get("chatHistory");
  const all = data.chatHistory || {};
  delete all[tabId];
  await chrome.storage.session.set({ chatHistory: all });
}

// ── Helper: call backend API ─────────────────────────────────

async function apiRequest(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const timeout = options._timeout || 60000; // 60s default
  delete options._timeout;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      ...options,
    });
    clearTimeout(timer);
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.detail || `API error ${resp.status}`);
    }
    return resp.json();
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw new Error("Request timed out. The page may be too large — try a simpler page.");
    }
    throw err;
  }
}

// ── Ensure content script is present ─────────────────────────

async function ensureContentScript(tabId) {
  const response = await chrome.tabs.sendMessage(tabId, {
    type: "EXTRACT_PAGE_CONTENT",
  }).catch(() => null);

  if (response && response.success) {
    return response;
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });

  const retryResponse = await chrome.tabs.sendMessage(tabId, {
    type: "EXTRACT_PAGE_CONTENT",
  }).catch(() => null);

  return retryResponse;
}

// ── Create a session for a tab ───────────────────────────────

async function initSession(tabId) {
  const response = await ensureContentScript(tabId);

  if (!response || !response.success) {
    throw new Error(response?.error || "Failed to extract page content.");
  }

  const { url, title, text_content, structured_data, language } = response.data;

  const session = await apiRequest("/session", {
    method: "POST",
    body: JSON.stringify({ url, title, text_content, structured_data, language }),
  });

  const sessionData = {
    sessionId: session.session_id,
    url: session.url,
    title: session.title,
    chunkCount: session.chunk_count,
  };

  await setTabSession(tabId, sessionData);
  return sessionData;
}

// ── Chat with backend ────────────────────────────────────────

async function chat(tabId, question) {
  const session = await getTabSession(tabId);
  if (!session) {
    throw new Error("No session for this tab. Click ⟳ to re-index the page.");
  }

  return apiRequest("/chat", {
    method: "POST",
    body: JSON.stringify({
      session_id: session.sessionId,
      question,
    }),
  });
}

// ── Streaming chat via SSE ───────────────────────────────────

async function chatStream(tabId, question, port) {
  const session = await getTabSession(tabId);
  if (!session) {
    port.postMessage({ error: "No session for this tab. Click ⟳ to re-index the page." });
    return;
  }

  let resp;
  try {
    resp = await fetch(`${API_BASE}/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: session.sessionId,
        question,
      }),
    });
  } catch (err) {
    port.postMessage({ error: err.message });
    return;
  }

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    port.postMessage({ error: body.detail || `API error ${resp.status}` });
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE lines from the buffer
      const lines = buffer.split("\n");
      // Keep the last incomplete line in the buffer
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = JSON.parse(line.slice(6));
        if (payload.token !== undefined) {
          port.postMessage({ token: payload.token });
        } else if (payload.done) {
          port.postMessage({ done: true, sources: payload.sources || [] });
        } else if (payload.error) {
          port.postMessage({ error: payload.error });
        }
      }
    }
  } catch (err) {
    port.postMessage({ error: err.message });
  }
}

// ── Multi-tab streaming via SSE ──────────────────────────────

async function chatMultiStream(sessionIds, question, port) {
  let resp;
  try {
    resp = await fetch(`${API_BASE}/chat/multi`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_ids: sessionIds, question }),
    });
  } catch (err) {
    port.postMessage({ error: err.message });
    return;
  }

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    port.postMessage({ error: body.detail || `API error ${resp.status}` });
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = JSON.parse(line.slice(6));
        if (payload.token !== undefined) {
          port.postMessage({ token: payload.token });
        } else if (payload.done) {
          port.postMessage({ done: true, sources: payload.sources || [] });
        } else if (payload.error) {
          port.postMessage({ error: payload.error });
        }
      }
    }
  } catch (err) {
    port.postMessage({ error: err.message });
  }
}

// ── Extension icon click → toggle side panel ─────────────────

chrome.action.onClicked.addListener(async (tab) => {
  // Ensure content script is injected, then toggle
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PANEL" });
  } catch {
    // Content script not loaded yet — inject then toggle
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
    await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PANEL" });
  }
});

// ── Clean up on tab close ────────────────────────────────────

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const session = await getTabSession(tabId);
  if (session) {
    apiRequest(`/session/${session.sessionId}`, { method: "DELETE" }).catch(
      () => {}
    );
    await removeTabSession(tabId);
  }
  await clearChatHistory(tabId);
});

// Re-init session on navigation to a different URL
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") {
    const session = await getTabSession(tabId);
    if (session && tab.url !== session.url) {
      apiRequest(`/session/${session.sessionId}`, {
        method: "DELETE",
      }).catch(() => {});
      await removeTabSession(tabId);
      await clearChatHistory(tabId);
    }

    // Notify any open panels that a new/updated tab is available
    // (for live multi-tab refresh)
    if (tab.url && !tab.url.startsWith("chrome://") && !tab.url.startsWith("chrome-extension://")) {
      broadcastToAllPanels({ type: "TABS_CHANGED", tabId, title: tab.title, url: tab.url });
    }
  }
});

// Also notify when a brand new tab is created
chrome.tabs.onCreated.addListener((tab) => {
  // New tabs start with no URL; the onUpdated "complete" event above
  // will fire once the page loads and broadcast TABS_CHANGED then.
});

/**
 * Broadcast a message to all content scripts (which relay to their iframes).
 * This lets the popup panel auto-refresh the multi-tab list.
 */
async function broadcastToAllPanels(message) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, message).catch(() => {});
  }
}

// ── Message handler from panel iframe ────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = async () => {
    try {
      // Determine the tab: if sent from the iframe inside a content script,
      // sender.tab is the page tab. Otherwise fall back to active tab.
      let tabId;
      if (sender.tab) {
        tabId = sender.tab.id;
      } else {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (!tab) throw new Error("No active tab found.");
        tabId = tab.id;
      }

      switch (message.type) {
        case "INIT_SESSION": {
          const existing = await getTabSession(tabId);
          if (existing) {
            const history = await loadChatHistory(tabId);
            return { success: true, session: existing, history };
          }
          const session = await initSession(tabId);
          return { success: true, session, history: [] };
        }

        case "CHAT": {
          const result = await chat(tabId, message.question);
          return { success: true, ...result };
        }

        case "SAVE_CHAT_HISTORY": {
          await saveChatHistory(tabId, message.messages);
          return { success: true };
        }

        case "LOAD_CHAT_HISTORY": {
          const history = await loadChatHistory(tabId);
          return { success: true, history };
        }

        case "RESET_SESSION": {
          const existing = await getTabSession(tabId);
          if (existing) {
            await apiRequest(
              `/session/${existing.sessionId}`,
              { method: "DELETE" }
            ).catch(() => {});
            await removeTabSession(tabId);
          }
          await clearChatHistory(tabId);
          const session = await initSession(tabId);
          return { success: true, session };
        }

        case "CLOSE_PANEL": {
          // Forward close message to the content script in the tab
          await chrome.tabs.sendMessage(tabId, { type: "CLOSE_PANEL" });
          return { success: true };
        }

        case "HIGHLIGHT_SOURCE": {
          await chrome.tabs.sendMessage(tabId, {
            type: "HIGHLIGHT_SOURCE",
            text: message.text,
          });
          return { success: true };
        }

        case "CLEAR_HIGHLIGHTS": {
          await chrome.tabs.sendMessage(tabId, { type: "CLEAR_HIGHLIGHTS" });
          return { success: true };
        }

        case "LIST_TAB_SESSIONS": {
          // Return ALL open browser tabs, marking which have sessions
          const allSessions = await loadSessions();
          const tabs = await chrome.tabs.query({});
          const entries = [];
          for (const tab of tabs) {
            // Skip chrome:// and extension pages
            if (!tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) continue;
            const sess = allSessions[tab.id];
            entries.push({
              tabId: tab.id,
              sessionId: sess ? sess.sessionId : null,
              title: tab.title || tab.url,
              url: tab.url,
              indexed: !!sess,
            });
          }
          return { success: true, sessions: entries };
        }

        case "PAGE_CONTENT_CHANGED": {
          // DOM changed significantly — re-index this tab if it has a session
          const existingSession = await getTabSession(tabId);
          if (existingSession) {
            // Delete old session, create new one
            apiRequest(`/session/${existingSession.sessionId}`, { method: "DELETE" }).catch(() => {});
            await removeTabSession(tabId);
            try {
              const newSession = await initSession(tabId);
              return { success: true, session: newSession, reindexed: true };
            } catch {
              return { success: false, error: "Re-index failed after DOM change." };
            }
          }
          return { success: true, reindexed: false };
        }

        case "INDEX_TAB": {
          // Index a specific tab on demand (for multi-tab)
          const targetTabId = message.tabId;
          const existing = await getTabSession(targetTabId);
          if (existing) {
            return { success: true, session: existing };
          }
          const session = await initSession(targetTabId);
          return { success: true, session };
        }

        default:
          return { success: false, error: "Unknown message type." };
      }
    } catch (err) {
      return { success: false, error: err.message };
    }
  };

  handler().then(sendResponse);
  return true;
});

// ── Port-based streaming for CHAT_STREAM ─────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "chat-stream") return;

  port.onMessage.addListener(async (message) => {
    // Determine tab id
    let tabId;
    if (port.sender && port.sender.tab) {
      tabId = port.sender.tab.id;
    } else {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab) {
        port.postMessage({ error: "No active tab found." });
        return;
      }
      tabId = tab.id;
    }

    if (message.type === "CHAT_STREAM") {
      await chatStream(tabId, message.question, port);
    }

    if (message.type === "CHAT_MULTI_STREAM") {
      await chatMultiStream(message.sessionIds, message.question, port);
    }
  });
});
