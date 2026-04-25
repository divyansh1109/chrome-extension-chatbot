/**
 * Popup UI logic – handles session init and chat.
 */

"use strict";

// ── DOM References ───────────────────────────────────────────

const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("user-input");
const btnSend = document.getElementById("btn-send");
const btnReset = document.getElementById("btn-reset");
const btnClose = document.getElementById("btn-close");
const btnMulti = document.getElementById("btn-multi");
const multiTabBar = document.getElementById("multi-tab-bar");
const multiTabList = document.getElementById("multi-tab-list");
const statusText = document.getElementById("status-text");
const statusBar = document.getElementById("status-bar");

// ── State ────────────────────────────────────────────────────

let isProcessing = false;
let chatMessages = []; // { role: "user"|"bot", text: string, sources?: string[] }
let multiTabMode = false;
let selectedSessionIds = [];

// ── Helpers ──────────────────────────────────────────────────

function setStatus(text, type = "") {
  statusText.textContent = text;
  statusBar.className = type; // "", "ready", "error"
}

function setInputEnabled(enabled) {
  inputEl.disabled = !enabled;
  btnSend.disabled = !enabled;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addMessage(text, role, extra = {}) {
  const div = document.createElement("div");
  div.classList.add("message", role);

  if (extra.isError) {
    div.classList.add("error");
  }

  // Simple markdown-like bold
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  div.innerHTML = escaped
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");

  // Append source snippets if provided
  if (extra.sources && extra.sources.length) {
    const srcDiv = document.createElement("div");
    srcDiv.className = "sources";
    const label = document.createElement("span");
    label.textContent = `📄 Based on ${extra.sources.length} page section(s):`;
    srcDiv.appendChild(label);

    const srcList = document.createElement("ul");
    srcList.className = "source-list";
    for (const src of extra.sources) {
      const li = document.createElement("li");
      li.className = "source-item";
      const srcText = typeof src === "string" ? src : src.text || "";
      const tabLabel = typeof src === "object" && src.tab ? ` [${src.tab}]` : "";
      li.textContent = srcText.slice(0, 100) + (srcText.length > 100 ? "…" : "") + tabLabel;
      li.title = "Click to highlight on page";
      li.addEventListener("click", () => {
        sendToBg({ type: "HIGHLIGHT_SOURCE", text: srcText });
      });
      srcList.appendChild(li);
    }
    srcDiv.appendChild(srcList);
    div.appendChild(srcDiv);
  }

  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

function showTyping() {
  const div = document.createElement("div");
  div.className = "typing-indicator";
  div.id = "typing";
  div.innerHTML = "<span></span><span></span><span></span>";
  messagesEl.appendChild(div);
  scrollToBottom();
}

function hideTyping() {
  const el = document.getElementById("typing");
  if (el) el.remove();
}

// ── Background messaging ─────────────────────────────────────

function sendToBg(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, resolve);
  });
}

// ── Chat history persistence ─────────────────────────────────

function persistHistory() {
  sendToBg({ type: "SAVE_CHAT_HISTORY", messages: chatMessages });
}

function restoreHistory(history) {
  for (const msg of history) {
    addMessage(msg.text, msg.role, { sources: msg.sources });
  }
}

// ── Session initialization ───────────────────────────────────

async function initSession() {
  setStatus("Analyzing page content…");
  setInputEnabled(false);

  const resp = await sendToBg({ type: "INIT_SESSION" });

  if (resp && resp.success) {
    const s = resp.session;
    setStatus(
      `Ready — ${s.chunkCount} sections indexed from "${s.title}"`,
      "ready"
    );
    setInputEnabled(true);

    // Restore previous chat or show welcome message
    if (resp.history && resp.history.length > 0) {
      chatMessages = resp.history;
      restoreHistory(chatMessages);
    } else {
      const welcome = `Hi! I've read this page. Ask me anything about **"${s.title}"**.`;
      addMessage(welcome, "bot");
      chatMessages.push({ role: "bot", text: welcome });
      persistHistory();
    }
    inputEl.focus();
  } else {
    const errMsg = resp?.error || "Could not connect to the backend server.";
    setStatus(errMsg, "error");
    addMessage(
      `⚠️ ${errMsg}`,
      "bot",
      { isError: true }
    );
  }
}

// ── Send a chat message (streaming) ──────────────────────────

async function sendMessage() {
  const question = inputEl.value.trim();
  if (!question || isProcessing) return;

  isProcessing = true;
  setInputEnabled(false);
  addMessage(question, "user");
  chatMessages.push({ role: "user", text: question });
  persistHistory();
  inputEl.value = "";
  autoResizeInput();

  showTyping();

  // Open a port to the background for streaming
  const port = chrome.runtime.connect({ name: "chat-stream" });

  let botDiv = null;
  let fullText = "";

  port.onMessage.addListener((msg) => {
    if (msg.error) {
      hideTyping();
      if (botDiv) botDiv.remove();
      const errText = `⚠️ ${msg.error}`;
      addMessage(errText, "bot", { isError: true });
      chatMessages.push({ role: "bot", text: errText });
      persistHistory();
      finishStream();
      port.disconnect();
      return;
    }

    if (msg.token !== undefined) {
      if (!botDiv) {
        hideTyping();
        botDiv = addMessage("", "bot");
      }
      fullText += msg.token;
      // Render with simple markdown-like bold and newlines
      const escaped = fullText
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      botDiv.innerHTML = escaped
        .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
        .replace(/\n/g, "<br>");
      scrollToBottom();
    }

    if (msg.done) {
      if (!botDiv) {
        hideTyping();
        botDiv = addMessage("", "bot");
      }
      // Append source info
      const sources = msg.sources || [];
      if (sources.length) {
        const srcDiv = document.createElement("div");
        srcDiv.className = "sources";
        const label = document.createElement("span");
        label.textContent = `📄 Based on ${sources.length} page section(s):`;
        srcDiv.appendChild(label);

        const srcList = document.createElement("ul");
        srcList.className = "source-list";
        for (const src of sources) {
          const li = document.createElement("li");
          li.className = "source-item";
          const srcText = typeof src === "string" ? src : src.text || "";
          const tabLabel = typeof src === "object" && src.tab ? ` [${src.tab}]` : "";
          li.textContent = srcText.slice(0, 100) + (srcText.length > 100 ? "…" : "") + tabLabel;
          li.title = "Click to highlight on page";
          li.addEventListener("click", () => {
            sendToBg({ type: "HIGHLIGHT_SOURCE", text: srcText });
          });
          srcList.appendChild(li);
        }
        srcDiv.appendChild(srcList);
        botDiv.appendChild(srcDiv);
      }
      chatMessages.push({ role: "bot", text: fullText, sources });
      persistHistory();
      finishStream();
      port.disconnect();
    }
  });

  if (multiTabMode && selectedSessionIds.length > 0) {
    port.postMessage({ type: "CHAT_MULTI_STREAM", sessionIds: selectedSessionIds, question });
  } else {
    port.postMessage({ type: "CHAT_STREAM", question });
  }

  function finishStream() {
    isProcessing = false;
    setInputEnabled(true);
    inputEl.focus();
  }
}

// ── Auto-resize textarea ─────────────────────────────────────

function autoResizeInput() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 80) + "px";
}

// ── Event listeners ──────────────────────────────────────────

btnSend.addEventListener("click", sendMessage);

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

inputEl.addEventListener("input", autoResizeInput);

btnReset.addEventListener("click", async () => {
  messagesEl.innerHTML = "";
  chatMessages = [];
  setStatus("Re-indexing page…");
  setInputEnabled(false);

  const resp = await sendToBg({ type: "RESET_SESSION" });

  if (resp && resp.success) {
    const s = resp.session;
    setStatus(
      `Ready — ${s.chunkCount} sections indexed from "${s.title}"`,
      "ready"
    );
    setInputEnabled(true);
    const welcome = `Page re-indexed! Ask me anything about **"${s.title}"**.`;
    addMessage(welcome, "bot");
    chatMessages.push({ role: "bot", text: welcome });
    persistHistory();
  } else {
    setStatus(resp?.error || "Failed to reset session.", "error");
  }
});

btnClose.addEventListener("click", () => {
  // Tell the background to forward CLOSE_PANEL to the content script
  chrome.runtime.sendMessage({ type: "CLOSE_PANEL" });
});

// ── Multi-tab mode ───────────────────────────────────────────

let tabEntries = []; // { tabId, sessionId, indexed }

async function refreshTabList() {
  const resp = await sendToBg({ type: "LIST_TAB_SESSIONS" });
  multiTabList.innerHTML = "";

  // Preserve previously selected session IDs
  const prevSelected = new Set(selectedSessionIds);
  selectedSessionIds = [];
  tabEntries = [];

  if (!resp || !resp.success || resp.sessions.length === 0) {
    multiTabList.innerHTML = '<span class="no-tabs">No other tabs open</span>';
    return;
  }

  for (const s of resp.sessions) {
    const entry = { tabId: s.tabId, sessionId: s.sessionId, indexed: s.indexed };
    tabEntries.push(entry);

    const chip = document.createElement("label");
    chip.className = "tab-chip" + (s.indexed ? "" : " not-indexed");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.tabId = s.tabId;

    // Re-check if was previously selected
    if (s.sessionId && prevSelected.has(s.sessionId)) {
      cb.checked = true;
      selectedSessionIds.push(s.sessionId);
    }

    cb.addEventListener("change", async () => {
      if (cb.checked) {
        if (!entry.indexed) {
          chip.classList.add("indexing");
          const indexResp = await sendToBg({ type: "INDEX_TAB", tabId: entry.tabId });
          chip.classList.remove("indexing");
          if (indexResp && indexResp.success) {
            entry.sessionId = indexResp.session.sessionId;
            entry.indexed = true;
            chip.classList.remove("not-indexed");
            const span = chip.querySelector("span");
            if (span) span.textContent = s.title.slice(0, 35) + (s.title.length > 35 ? "…" : "");
          } else {
            cb.checked = false;
            return;
          }
        }
        if (entry.sessionId && !selectedSessionIds.includes(entry.sessionId)) {
          selectedSessionIds.push(entry.sessionId);
        }
      } else {
        selectedSessionIds = selectedSessionIds.filter((id) => id !== entry.sessionId);
      }
    });

    const text = document.createElement("span");
    const titleLabel = s.title.slice(0, 35) + (s.title.length > 35 ? "…" : "");
    text.textContent = s.indexed ? titleLabel : `${titleLabel} ⏳`;
    text.title = s.indexed ? s.url : `${s.url}\n(will be indexed when selected)`;

    chip.appendChild(cb);
    chip.appendChild(text);
    multiTabList.appendChild(chip);
  }
}

btnMulti.addEventListener("click", async () => {
  multiTabMode = !multiTabMode;
  btnMulti.classList.toggle("active", multiTabMode);
  multiTabBar.classList.toggle("hidden", !multiTabMode);

  if (multiTabMode) {
    selectedSessionIds = [];
    await refreshTabList();
  } else {
    selectedSessionIds = [];
    tabEntries = [];
  }
});

// Listen for new/updated tabs broadcast from background → content → popup iframe
window.addEventListener("message", (event) => {
  if (event.data && event.data.type === "TABS_CHANGED" && multiTabMode) {
    refreshTabList();
  }
});

// ── Init ─────────────────────────────────────────────────────

initSession();
