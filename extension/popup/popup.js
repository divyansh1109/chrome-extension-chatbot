/**
 * Popup UI logic – handles session init, chat, and voice input.
 */

"use strict";

// ── DOM References ───────────────────────────────────────────

const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("user-input");
const btnSend = document.getElementById("btn-send");
const btnVoice = document.getElementById("btn-voice");
const btnReset = document.getElementById("btn-reset");
const statusText = document.getElementById("status-text");
const statusBar = document.getElementById("status-bar");

// ── State ────────────────────────────────────────────────────

let isProcessing = false;
let isRecording = false;
let recognition = null; // SpeechRecognition instance

// ── Helpers ──────────────────────────────────────────────────

function setStatus(text, type = "") {
  statusText.textContent = text;
  statusBar.className = type; // "", "ready", "error"
}

function setInputEnabled(enabled) {
  inputEl.disabled = !enabled;
  btnSend.disabled = !enabled;
  btnVoice.disabled = !enabled;
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

// ── Send a chat message ──────────────────────────────────────

async function sendMessage() {
  const question = inputEl.value.trim();
  if (!question || isProcessing) return;

  isProcessing = true;
  setInputEnabled(false);
  addMessage(question, "user");
  inputEl.value = "";
  autoResizeInput();

  showTyping();

  const resp = await sendToBg({ type: "CHAT", question });

  hideTyping();

  if (resp && resp.success) {
    addMessage(resp.answer, "bot", { sources: resp.sources });
  } else {
    addMessage(
      `⚠️ ${resp?.error || "Something went wrong. Please try again."}`,
      "bot",
      { isError: true }
    );
  }

  isProcessing = false;
  setInputEnabled(true);
  inputEl.focus();
}

// ── Auto-resize textarea ─────────────────────────────────────

function autoResizeInput() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 80) + "px";
}

// ── Voice Input (Web Speech API) ─────────────────────────────

function initVoice() {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    btnVoice.title = "Voice input not supported in this browser";
    btnVoice.style.display = "none";
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = "en-US";

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    inputEl.value = transcript;
    autoResizeInput();
    stopRecording();
    // Auto-send after voice input
    sendMessage();
  };

  recognition.onerror = (event) => {
    console.warn("Speech recognition error:", event.error);
    stopRecording();
    if (event.error === "not-allowed") {
      addMessage(
        "⚠️ Microphone access denied. Please allow microphone in browser settings.",
        "bot",
        { isError: true }
      );
    }
  };

  recognition.onend = () => {
    stopRecording();
  };
}

function startRecording() {
  if (!recognition || isRecording) return;
  isRecording = true;
  btnVoice.classList.add("recording");
  btnVoice.title = "Listening… click to stop";
  recognition.start();
}

function stopRecording() {
  if (!recognition || !isRecording) return;
  isRecording = false;
  btnVoice.classList.remove("recording");
  btnVoice.title = "Voice input";
  try {
    recognition.stop();
  } catch (_) {
    // already stopped
  }
}

function toggleRecording() {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
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

btnVoice.addEventListener("click", toggleRecording);

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

// ── Init ─────────────────────────────────────────────────────

initVoice();
initSession();
