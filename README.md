# Webpage Chatbot – Chrome Extension

A Chrome extension that lets you **chat about any webpage** you're viewing. Ask questions about product specs, article content, documentation — anything on the page. Powered by a Python/FastAPI backend with LangChain RAG (Retrieval-Augmented Generation).

**Target audience:** General web users, online shoppers, researchers, students — anyone who wants to interrogate page content conversationally.

### Key Features

- **Server-rendered thin-shell architecture** — chat UI served by the backend (Jinja2 + Alpine.js), extension is ~250 lines total
- **Streaming chat** — token-by-token SSE responses for real-time typing effect
- **Multi-tab context** — query across multiple open tabs simultaneously (e.g. compare products)
- **Persistent chat history** — conversations stored in SQLite, survive browser close (30-min TTL)
- **Dynamic page support** — MutationObserver detects significant DOM changes and auto-re-indexes
- **Live tab detection** — new browser tabs appear in the multi-tab selector automatically
- **LLM fallback chain** — OpenAI → Ollama (Gemma 2 / Qwen2.5) waterfall so the extension never breaks
- **Rate limiting** — server-side rate limits via slowapi to prevent abuse
- **Structured data extraction** — JSON-LD parsing for clean product/article data
- **Deployable** — runs locally or on Railway / any cloud host

---

## Architecture Overview

```
┌──────────────────────────────────┐
│        Chrome Extension          │
│  ┌────────────┐ ┌──────────────┐ │
│  │content.js  │ │background.js │ │
│  │(DOM scraper│ │(session init,│ │
│  │ + iframe)  │ │ tab lifecycle│ │
│  │ ~140 lines │ │  ~100 lines) │ │
│  └──────┬─────┘ └──────┬───────┘ │
│         │ iframe.src   │ HTTP    │
│         ▼              ▼         │
│  ┌──────────────────────────────┐│
│  │ Backend-served <iframe>      ││
│  │ Jinja2 + Alpine.js chat UI   ││
│  └──────────────────────────────┘│
└──────────────┬───────────────────┘
               │ HTTPS
┌──────────────┼───────────────────┐
│  Python Backend (FastAPI)        │
│  ┌───────────┴────────────────┐  │
│  │  /chat-ui → server-rendered│  │
│  │  /session → build RAG index│  │
│  │  /chat/stream → SSE tokens │  │
│  │  /chat/multi  → multi-tab  │  │
│  │  /history → SQLite persist │  │
│  │  /tabs    → tab registry   │  │
│  ├────────────────────────────┤  │
│  │  LangChain + FAISS         │  │
│  │  OpenAI (primary)          │  │
│  │  Ollama fallbacks:         │  │
│  │    Gemma 2 9B / Qwen2.5 7B│  │
│  ├────────────────────────────┤  │
│  │  SQLite (chat history +    │  │
│  │          tab registry)     │  │
│  └────────────────────────────┘  │
└──────────────────────────────────┘
```

### Data Flow

1. **User clicks extension icon** → Background worker extracts page text via the content script.
2. **Content script** strips noise (nav, footer, scripts, ads), extracts JSON-LD structured data, detects page language, and returns the data.
3. **Background worker** sends text + structured data + language to `POST /session` → backend splits it into chunks, embeds them into a FAISS vector index, and returns a session ID.
4. **Content script** injects an iframe pointing to `/chat-ui?session_id=...` on the backend.
5. **User asks a question** → iframe sends `POST /chat/stream` directly to the backend → retrieves relevant chunks, feeds them + chat history to the LLM, and **streams tokens back** via Server-Sent Events.
6. **Multi-tab query** *(optional)* → `POST /chat/multi` retrieves from multiple sessions' vectorstores, merges results with tab attribution, and streams the answer.
7. **Dynamic page update** → MutationObserver detects significant content changes → auto-re-indexes the page.
8. **Tab closed** → `DELETE /tabs/{tabId}` cleans up server-side state.

---

## Quickstart

### Prerequisites

- Python 3.12+
- An [OpenAI API key](https://platform.openai.com/api-keys)
- Google Chrome (or Chromium-based browser)
- *(Optional)* [Ollama](https://ollama.com/) for local fallback models

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

# (Optional) Pull Ollama fallback models
ollama pull gemma2:9b
ollama pull qwen2.5:7b

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
2. Click the extension icon → it indexes the page and opens the chat panel
3. Type a question → get a streamed answer

---

## Project Structure

```
chrome_ext_chatbot/
├── backend/
│   ├── config.py           # Settings from environment variables
│   ├── models.py           # Pydantic request/response schemas
│   ├── chain.py            # LangChain vectorstore + retrieval chain + LLM fallbacks
│   ├── session_manager.py  # Per-tab session lifecycle (TTL, eviction)
│   ├── chat_store.py       # SQLite chat history + tab registry
│   ├── server.py           # FastAPI app with all endpoints
│   ├── templates/
│   │   └── chat.html       # Jinja2 + Alpine.js chat UI
│   └── static/
│       └── alpine.min.js   # Self-hosted Alpine.js (15 KB)
├── extension/
│   ├── manifest.json       # Chrome MV3 manifest (v2.0.0)
│   ├── background.js       # Thin service worker (~100 lines)
│   ├── content.js          # DOM text extraction + iframe injection (~140 lines)
│   └── icons/              # Extension icons
├── tests/
│   ├── test_config.py
│   ├── test_session_manager.py
│   ├── test_chat_store.py
│   └── test_server.py
├── main.py                 # Entry point (uvicorn launcher)
├── pyproject.toml
├── TECHNICAL_DOCS.md       # Comprehensive technical documentation
└── README.md
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | *(required)* | Your OpenAI API key |
| `CHAT_MODEL` | `gpt-4o-mini` | Primary LLM model name |
| `CHUNK_SIZE` | `1500` | Text chunk size (chars) for splitting |
| `CHUNK_OVERLAP` | `200` | Overlap between chunks |
| `HOST` | `0.0.0.0` | Server bind address |
| `PORT` | `8765` | Server port |
| `CORS_ORIGINS` | `chrome-extension://*` | Allowed CORS origins |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL for fallback models |
| `FALLBACK_MODEL` | `gemma2:9b` | Ollama fallback model (English/general) |
| `MULTILINGUAL_MODEL` | `qwen2.5:7b` | Ollama fallback model (non-English pages) |

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `POST` | `/session` | Index page content → returns `session_id` |
| `POST` | `/chat` | Ask a question → returns AI answer |
| `POST` | `/chat/stream` | Ask a question → streams tokens via SSE |
| `POST` | `/chat/multi` | Multi-tab query → streams answer with tab attribution |
| `DELETE` | `/session/{id}` | Delete a session |
| `GET` | `/chat-ui` | Server-rendered chat UI (loaded in iframe) |
| `POST` | `/history/{id}` | Save chat messages to SQLite |
| `GET` | `/tabs` | List all registered tabs |
| `POST` | `/tabs/{id}` | Register a tab |
| `DELETE` | `/tabs/{id}` | Unregister a tab |
| `GET` | `/docs` | Interactive Swagger docs |

**Rate limits** (via slowapi): `/session` 10/min, `/chat` & `/chat/stream` 20/min, `/chat/multi` 10/min.

---

## Running Tests

```bash
python -m pytest tests/ -v
```

Tests use mocks for OpenAI/FAISS calls — no API key or network needed. 38 tests covering all endpoints, chat history, tab registry, and cleanup logic.

---

## LLM Fallback Strategy

| Priority | English Pages | Non-English Pages |
|---|---|---|
| 1 (primary) | OpenAI (gpt-4o-mini) | OpenAI (gpt-4o-mini) |
| 2 (fallback) | Gemma 2 9B (via Ollama) | Qwen2.5 7B (via Ollama) |
| 3 (fallback) | Qwen2.5 7B (via Ollama) | Gemma 2 9B (via Ollama) |

If the primary model fails (expired key, rate limit, network), the chain automatically tries the next model. Requires Ollama for fallbacks (`ollama pull gemma2:9b && ollama pull qwen2.5:7b`).

---

## Deployment

The backend is deployed to [Railway](https://railway.app/) at:
`https://chrome-extension-chatbot-production.up.railway.app`

```bash
# Deploy to Railway
railway link
railway up
```

Set `OPENAI_API_KEY` as a Railway environment variable. Update `API_BASE` in `extension/background.js` and `extension/content.js` to your deployed URL.

---

## Privacy & Security

| Concern | Mitigation |
|---|---|
| **Page scraping** | All extraction happens locally in your browser via the content script |
| **API key** | Stored in `.env` on the server. Never sent to the extension or exposed client-side |
| **CORS** | Backend restricts origins to `chrome-extension://*` by default |
| **Content extraction** | Only runs when you click the extension icon — not on every page load |
| **Data retention** | Chat history TTL: 30 minutes. In-memory sessions evicted on tab close or TTL |
| **Input validation** | Pydantic enforces types and length limits on all requests |
| **SQL injection** | Parameterized queries (`?` placeholders) throughout |

---

## Known Limitations

| Challenge | Workaround |
|---|---|
| JS-rendered SPAs may miss dynamically loaded content | MutationObserver auto-re-indexes; click reset (⟳) as fallback |
| Very large pages truncated (30K chars, 30 chunks max) | Increase limits in `content.js` / `chain.py` |
| Cross-origin iframes inaccessible | Chrome security limitation — no workaround |
| Service worker killed after ~30s idle | Thin shell design — all long-lived connections are iframe ↔ server |

---

## Documentation

See [TECHNICAL_DOCS.md](TECHNICAL_DOCS.md) for a comprehensive beginner-to-advanced guide covering architecture, computer science concepts, code-level details, and every data flow in the project.

---

## License

MIT
