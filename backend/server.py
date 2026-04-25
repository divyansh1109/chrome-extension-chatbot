"""FastAPI server exposing chat endpoints for the Chrome extension."""

from __future__ import annotations

import json
import logging
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import StreamingResponse

from backend.config import Settings
from backend.models import ChatRequest, ChatResponse, PageContent, SessionInfo
from backend.session_manager import SessionManager

logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    """Application factory."""
    if settings is None:
        settings = Settings.from_env()

    app = FastAPI(
        title="Webpage Chatbot API",
        version="0.1.0",
        docs_url="/docs",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["*"],
    )

    manager = SessionManager(settings)

    # ── Endpoints ──────────────────────────────────────────────

    @app.get("/health")
    async def health_check():
        return {"status": "ok"}

    @app.post("/session", response_model=SessionInfo)
    async def create_session(payload: PageContent):
        """Receive page content from the extension and build a chat session."""
        if not payload.text_content.strip():
            raise HTTPException(
                status_code=400,
                detail="Page content is empty; nothing to chat about.",
            )

        session_id = uuid.uuid4().hex[:12]
        session = manager.create_session(
            session_id=session_id,
            url=payload.url,
            title=payload.title,
            text_content=payload.text_content,
            structured_data=payload.structured_data,
            language=payload.language,
        )
        return SessionInfo(
            session_id=session.session_id,
            url=session.url,
            title=session.title,
            chunk_count=session.chunk_count,
        )

    @app.post("/chat", response_model=ChatResponse)
    async def chat(req: ChatRequest):
        """Answer a user question using the session's retrieval chain."""
        session = manager.get_session(req.session_id)
        if not session:
            raise HTTPException(
                status_code=404,
                detail="Session not found. Please reload the page to start a new session.",
            )

        try:
            result = await _run_chain(session, req.question)
        except Exception:
            logger.exception("Chain invocation failed for session %s", req.session_id)
            raise HTTPException(
                status_code=500,
                detail="Failed to generate a response. Please try again.",
            )

        sources = result.get("source_documents", [])
        return ChatResponse(
            answer=result["answer"],
            session_id=req.session_id,
            sources=sources,
        )

    @app.post("/chat/stream")
    async def chat_stream(req: ChatRequest):
        """Stream tokens back as Server-Sent Events."""
        session = manager.get_session(req.session_id)
        if not session:
            raise HTTPException(
                status_code=404,
                detail="Session not found. Please reload the page to start a new session.",
            )

        import asyncio

        _STREAM_END = object()

        def _next_token(gen):
            """Wrapper around next() that converts StopIteration to a sentinel."""
            try:
                return next(gen)
            except StopIteration as e:
                return _STREAM_END, e.value

        async def event_generator():
            loop = asyncio.get_event_loop()
            gen = await loop.run_in_executor(
                None,
                lambda: session.chat_session.stream(req.question),
            )
            sources = []
            try:
                while True:
                    result = await loop.run_in_executor(None, _next_token, gen)
                    if isinstance(result, tuple) and result[0] is _STREAM_END:
                        meta = result[1] or {}
                        sources = meta.get("source_documents", [])
                        break
                    yield f"data: {json.dumps({'token': result})}\n\n"
            except Exception:
                logger.exception(
                    "Streaming failed for session %s", req.session_id
                )
                yield f"data: {json.dumps({'error': 'Stream failed'})}\n\n"
                return
            yield f"data: {json.dumps({'done': True, 'sources': sources})}\n\n"

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )

    @app.delete("/session/{session_id}")
    async def delete_session(session_id: str):
        """Clean up a session when a tab is closed."""
        manager.delete_session(session_id)
        return {"status": "deleted"}

    return app


async def _run_chain(session, question: str) -> dict:
    """Invoke the chat session; run in executor since LangChain may block."""
    import asyncio

    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        None,
        lambda: session.chat_session.invoke(question),
    )
