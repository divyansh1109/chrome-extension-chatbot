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
const statusText = document.getElementById("status-text");
const statusBar = document.getElementById("status-bar");

// ── State ────────────────────────────────────────────────────

let isProcessing = false;

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
    srcDiv.textContent = `📄 Based on ${extra.sources.length} page section(s)`;
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
    addMessage(
      `Hi! I've read this page. Ask me anything about **"${s.title}"**.`,
      "bot"
    );
    inputEl.focus();
  } else {
    const errMsg = resp?.error || "Could not connect to the backend server.";
    setStatus(errMsg, "error");
    addMessage(
      `⚠️ ${errMsg}\n\nMake sure the backend server is running on http://127.0.0.1:8765`,
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
      addMessage(
        `⚠️ ${msg.error}`,
        "bot",
        { isError: true }
      );
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
      if (msg.sources && msg.sources.length) {
        const srcDiv = document.createElement("div");
        srcDiv.className = "sources";
        srcDiv.textContent = `📄 Based on ${msg.sources.length} page section(s)`;
        botDiv.appendChild(srcDiv);
      }
      finishStream();
      port.disconnect();
    }
  });

  port.postMessage({ type: "CHAT_STREAM", question });

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
    addMessage(
      `Page re-indexed! Ask me anything about **"${s.title}"**.`,
      "bot"
    );
  } else {
    setStatus(resp?.error || "Failed to reset session.", "error");
  }
});

btnClose.addEventListener("click", () => {
  // Tell the background to forward CLOSE_PANEL to the content script
  chrome.runtime.sendMessage({ type: "CLOSE_PANEL" });
});

// ── Init ─────────────────────────────────────────────────────

initSession();
