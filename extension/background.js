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

// ── Helper: call backend API ─────────────────────────────────

async function apiRequest(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const resp = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.detail || `API error ${resp.status}`);
  }
  return resp.json();
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
    }
  }
});

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
            return { success: true, session: existing };
          }
          const session = await initSession(tabId);
          return { success: true, session };
        }

        case "CHAT": {
          const result = await chat(tabId, message.question);
          return { success: true, ...result };
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
          const session = await initSession(tabId);
          return { success: true, session };
        }

        case "CLOSE_PANEL": {
          // Forward close message to the content script in the tab
          await chrome.tabs.sendMessage(tabId, { type: "CLOSE_PANEL" });
          return { success: true };
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
  });
});
