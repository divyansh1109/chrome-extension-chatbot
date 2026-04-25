"""Manages per-tab chat sessions with vectorstore and chain instances."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from threading import Lock

from langchain_community.vectorstores import FAISS

from typing import Any

from backend.chain import ChatSession, build_vectorstore
from backend.config import Settings

logger = logging.getLogger(__name__)

# Evict sessions idle for longer than 30 minutes
SESSION_TTL_SECONDS = 30 * 60
MAX_SESSIONS = 50


@dataclass
class Session:
    """Holds the state for one browser tab's chat."""

    session_id: str
    url: str
    title: str
    vectorstore: FAISS
    chat_session: ChatSession
    chunk_count: int
    created_at: float = field(default_factory=time.time)
    last_active: float = field(default_factory=time.time)

    def touch(self) -> None:
        self.last_active = time.time()


class SessionManager:
    """Thread-safe session store with TTL eviction."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._sessions: dict[str, Session] = {}
        self._lock = Lock()

    def create_session(
        self,
        session_id: str,
        url: str,
        title: str,
        text_content: str,
        structured_data: list[dict[str, Any]] | None = None,
        language: str = "",
    ) -> Session:
        """Build a new session (vectorstore + chain) for a page."""
        self._evict_stale()

        vectorstore = build_vectorstore(
            text_content, self._settings, structured_data=structured_data,
        )
        multilingual = bool(language and not language.lower().startswith("en"))
        chat_session = ChatSession(
            vectorstore, self._settings, multilingual=multilingual,
        )
        chunk_count = vectorstore.index.ntotal

        session = Session(
            session_id=session_id,
            url=url,
            title=title,
            vectorstore=vectorstore,
            chat_session=chat_session,
            chunk_count=chunk_count,
        )
        with self._lock:
            # Replace existing session for same id
            self._sessions[session_id] = session
        logger.info(
            "Session created: %s (%d chunks) for %s",
            session_id,
            chunk_count,
            url,
        )
        return session

    def get_session(self, session_id: str) -> Session | None:
        with self._lock:
            session = self._sessions.get(session_id)
        if session:
            session.touch()
        return session

    def delete_session(self, session_id: str) -> None:
        with self._lock:
            self._sessions.pop(session_id, None)

    def _evict_stale(self) -> None:
        now = time.time()
        with self._lock:
            stale = [
                sid
                for sid, s in self._sessions.items()
                if now - s.last_active > SESSION_TTL_SECONDS
            ]
            for sid in stale:
                del self._sessions[sid]
                logger.info("Evicted stale session: %s", sid)

            # Hard cap: remove oldest if over limit
            if len(self._sessions) >= MAX_SESSIONS:
                oldest = min(self._sessions, key=lambda k: self._sessions[k].last_active)
                del self._sessions[oldest]
                logger.info("Evicted oldest session (cap): %s", oldest)
