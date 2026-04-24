/**
 * Background service worker for the Webpage Chatbot extension.
 * Manages communication between the popup, content script, and backend server.
 */

const API_BASE = "http://127.0.0.1:8765";

/**
 * Store session data keyed by tab ID.
 * { [tabId]: { sessionId, url, title, chunkCount } }
 */
const tabSessions = {};

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

// ── Create a session for a tab ───────────────────────────────

async function initSession(tabId) {
  // Ask the content script to extract page text
  const [response] = await chrome.tabs.sendMessage(tabId, {
    type: "EXTRACT_PAGE_CONTENT",
  }).then((r) => [r]).catch(() => [null]);

  if (!response || !response.success) {
    throw new Error(response?.error || "Failed to extract page content.");
  }

  const { url, title, text_content } = response.data;

  // Send to backend to build vectorstore
  const session = await apiRequest("/session", {
    method: "POST",
    body: JSON.stringify({ url, title, text_content }),
  });

  tabSessions[tabId] = {
    sessionId: session.session_id,
    url: session.url,
    title: session.title,
    chunkCount: session.chunk_count,
  };

  return tabSessions[tabId];
}

// ── Chat with backend ────────────────────────────────────────

async function chat(tabId, question) {
  const session = tabSessions[tabId];
  if (!session) {
    throw new Error("No session for this tab. Please reload the page.");
  }

  return apiRequest("/chat", {
    method: "POST",
    body: JSON.stringify({
      session_id: session.sessionId,
      question,
    }),
  });
}

// ── Clean up on tab close ────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  const session = tabSessions[tabId];
  if (session) {
    apiRequest(`/session/${session.sessionId}`, { method: "DELETE" }).catch(
      () => {}
    );
    delete tabSessions[tabId];
  }
});

// Re-init session on navigation
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete" && tabSessions[tabId]) {
    // URL changed — invalidate old session
    chrome.tabs.get(tabId, (tab) => {
      if (tab && tab.url !== tabSessions[tabId].url) {
        apiRequest(`/session/${tabSessions[tabId].sessionId}`, {
          method: "DELETE",
        }).catch(() => {});
        delete tabSessions[tabId];
      }
    });
  }
});

// ── Message handler from popup ───────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = async () => {
    try {
      switch (message.type) {
        case "INIT_SESSION": {
          const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });
          if (!tab) throw new Error("No active tab found.");

          // Return existing session or create new
          if (tabSessions[tab.id]) {
            return { success: true, session: tabSessions[tab.id] };
          }
          const session = await initSession(tab.id);
          return { success: true, session };
        }

        case "CHAT": {
          const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });
          if (!tab) throw new Error("No active tab found.");
          const result = await chat(tab.id, message.question);
          return { success: true, ...result };
        }

        case "RESET_SESSION": {
          const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });
          if (!tab) throw new Error("No active tab found.");
          if (tabSessions[tab.id]) {
            await apiRequest(
              `/session/${tabSessions[tab.id].sessionId}`,
              { method: "DELETE" }
            ).catch(() => {});
            delete tabSessions[tab.id];
          }
          const session = await initSession(tab.id);
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
  return true; // async response
});
