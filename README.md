# Webpage Chatbot – Chrome Extension

A Chrome extension that lets you **chat about any webpage** you're viewing. Ask questions about product specs, article content, documentation — anything on the page. Powered by a Python/FastAPI backend with LangChain RAG (Retrieval-Augmented Generation).

**Target audience:** General web users, online shoppers, researchers, students — anyone who wants to interrogate page content conversationally.

---

## Architecture Overview

```
┌──────────────────────────────────┐
│        Chrome Extension          │
│  ┌────────┐  ┌───────────────┐   │
│  │ Popup  │  │Content Script │   │
│  │  (UI)  │  │ (DOM scraper) │   │
│  └───┬────┘  └──────┬────────┘   │
│      │               │           │
│  ┌───┴───────────────┴────────┐  │
│  │   Background Service Worker │  │
│  └────────────┬───────────────┘  │
└───────────────┼──────────────────┘
                │  HTTP (localhost)
┌───────────────┼──────────────────┐
│  Python Backend (FastAPI)        │
│  ┌────────────┴───────────────┐  │
│  │    /session  →  build RAG  │  │
│  │    /chat     →  query RAG  │  │
│  ├────────────────────────────┤  │
│  │  LangChain + FAISS + GPT  │  │
│  └────────────────────────────┘  │
└──────────────────────────────────┘
```

### Data Flow

1. **User opens popup** → Background worker asks the content script to extract page text.
2. **Content script** strips noise (nav, footer, scripts, ads) and returns clean text.
3. **Background worker** sends text to `POST /session` → backend splits it into chunks, embeds them into a FAISS vector index, and returns a session ID.
4. **User asks a question** → `POST /chat` → backend retrieves the most relevant chunks, feeds them + chat history to GPT, returns the answer.
5. **Tab closed / URL changed** → `DELETE /session/:id` cleans up server memory.

---

## Quickstart

### Prerequisites

- Python 3.12+
- An [OpenAI API key](https://platform.openai.com/api-keys)
- Google Chrome (or Chromium-based browser)

### 1. Backend Setup

```bash
# Clone & enter the project
cd chrome_ext_chatbot

# Create virtual environment
python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS/Linux
source .venv/bin/activate

# Install dependencies
pip install -e ".[dev]"

# Configure environment
cp .env.example .env
# Edit .env and add your OPENAI_API_KEY

# Start the backend server
python main.py
```

The server starts on `http://127.0.0.1:8765`. Verify with:
```bash
curl http://127.0.0.1:8765/health
# → {"status":"ok"}
```

### 2. Load the Chrome Extension

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `extension/` folder
4. Pin the extension icon to your toolbar

### 3. Use It

1. Navigate to any webpage
2. Click the extension icon → it indexes the page automatically
3. Type a question (or use the 🎤 voice button) → get an answer

---

## Project Structure

```
chrome_ext_chatbot/
├── backend/
│   ├── __init__.py
│   ├── config.py           # Settings from environment variables
│   ├── models.py           # Pydantic request/response schemas
│   ├── chain.py            # LangChain vectorstore + retrieval chain
│   ├── session_manager.py  # Per-tab session lifecycle (TTL, eviction)
│   └── server.py           # FastAPI app with /session, /chat, /health
├── extension/
│   ├── manifest.json       # Chrome MV3 manifest
│   ├── background.js       # Service worker (API bridge)
│   ├── content.js          # DOM text extraction (injected per page)
│   ├── icons/              # Extension icons (add your own PNGs)
│   └── popup/
│       ├── popup.html      # Chat UI shell
│       ├── popup.css       # Dark-themed styles
│       └── popup.js        # Chat logic + voice input
├── tests/
│   ├── test_config.py
│   ├── test_session_manager.py
│   └── test_server.py
├── main.py                 # Entry point (uvicorn launcher)
├── pyproject.toml
├── .env.example
└── README.md
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | *(required)* | Your OpenAI API key |
| `CHAT_MODEL` | `gpt-4o-mini` | LLM model name |
| `CHUNK_SIZE` | `1000` | Text chunk size (chars) for splitting |
| `CHUNK_OVERLAP` | `200` | Overlap between chunks |
| `HOST` | `127.0.0.1` | Server bind address |
| `PORT` | `8765` | Server port |
| `CORS_ORIGINS` | `chrome-extension://*` | Allowed CORS origins |

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `POST` | `/session` | Index page content → returns `session_id` |
| `POST` | `/chat` | Ask a question → returns AI answer |
| `DELETE` | `/session/{id}` | Delete a session |
| `GET` | `/docs` | Interactive Swagger docs |

---

## Running Tests

```bash
pytest -v
```

Tests use mocks for OpenAI/FAISS calls — no API key or network needed.

---

## Example User Interactions

### Amazon Product Page
```
User: "What is the battery life of these headphones?"
Bot:  "According to the page, the Sony WH-1000XM5 offers up to 30 hours
       of battery life with noise cancellation enabled, and 40 hours
       with it off."

User: "Does it support multipoint connection?"
Bot:  "Yes — the page states it supports simultaneous multi-point
       connection to two Bluetooth devices."

User: "Compare it with the XM4"
Bot:  "The page doesn't contain comparison data with the XM4.
       I can only answer based on what's on this page."
```

### Wikipedia Article
```
User: "Summarize this article in 3 bullet points"
Bot:  "• The article covers the history of the Roman Empire from 27 BC...
       • Key sections discuss the Pax Romana period...
       • The decline is attributed to..."
```

### Edge Case: Missing Information
```
User: "What's the shipping cost?"
Bot:  "I don't see shipping cost information on this page. The page
       primarily contains product description and specifications."
```

---

## Voice Input

The extension uses the **Web Speech API** (`SpeechRecognition`) built into Chrome:

- Click the 🎤 microphone button to start listening
- Speak your question naturally
- The transcript is auto-sent when speech ends
- Red pulse animation indicates active recording

**Browser compatibility:** Chrome 33+, Edge 79+. Firefox/Safari have limited support. The button hides itself on unsupported browsers.

**Privacy:** Audio is processed by Chrome's speech service (Google servers). No audio is sent to the Python backend — only the text transcript.

---

## Multi-Turn Conversation

The backend uses `ConversationBufferWindowMemory` (last 10 turns) so follow-up questions work naturally:

```
User: "What processor does this laptop use?"
Bot:  "It uses an Intel Core i7-13700H."

User: "How much RAM does it have?"     ← implicit "it" = the laptop
Bot:  "The page lists 16 GB DDR5 RAM."
```

Sessions are per-tab and auto-evicted after 30 minutes of inactivity (max 50 concurrent sessions).

---

## Privacy & Security

| Concern | Mitigation |
|---|---|
| **Page scraping** | All extraction happens locally in your browser via the content script. No page data is sent to third parties — only to your localhost backend. |
| **API key** | Stored in `.env` on your machine. Never sent to the extension or exposed client-side. |
| **CORS** | Backend restricts origins to `chrome-extension://*` by default. |
| **Sensitive pages** | The content script runs on all URLs but only extracts when you open the popup. Banking/medical pages are not auto-scraped. |
| **Data retention** | Sessions are memory-only, never persisted to disk. Evicted on tab close or TTL expiry. |

---

## Known Limitations & Workarounds

| Challenge | Impact | Workaround |
|---|---|---|
| **JS-rendered SPAs** | Content script may miss dynamically loaded content | Click the ⟳ reset button after the page fully loads; or increase `run_at` delay |
| **Very large pages** | Content truncated at 100K chars | Increase limit in `content.js`; consider chunking strategy tuning |
| **Cross-origin iframes** | Cannot access content inside iframes from different origins | Chrome security model limitation — no workaround |
| **Rate limits** | OpenAI API rate limits on heavy use | Use `gpt-4o-mini` (cheaper/faster); add client-side throttling |
| **Performance** | Initial indexing takes 2-5s depending on page size | Show loading indicator (implemented); consider streaming responses |
| **Scraping restrictions** | Some sites block content scripts or use shadow DOM | Fallback to `document.body.innerText`; manual text paste as alternative |

---

## Alternative Architectures

### JS-Heavy (No Python Backend)
Run everything in the extension using `transformers.js` or call OpenAI directly from the service worker. **Pros:** No server needed. **Cons:** No vector search, limited context window, API key exposed in extension code.

### Cloud-Hosted Backend
Deploy the FastAPI server to a cloud provider. **Pros:** Accessible from any machine. **Cons:** Latency, cost, need to secure the API, page content leaves the user's machine.

### Local LLM (Ollama/llama.cpp)
Replace OpenAI with a local model. **Pros:** Fully private, no API cost. **Cons:** Requires a capable GPU, slower inference, lower quality answers.

---

## Future Enhancements

- **Streaming responses** via SSE for real-time typing effect
- **PDF / file viewer support** (extract text from embedded PDFs)
- **Highlight source text** on the page when showing answer sources
- **Multi-tab context** — ask questions across several open tabs
- **Summarize on open** — auto-generate a TL;DR when the popup opens
- **Export chat** — save conversation as markdown
- **Custom prompts** — let users define system prompts for different use cases

---

## License

MIT
