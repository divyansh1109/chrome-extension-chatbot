"""Unit tests for the session manager."""

import time
from unittest.mock import MagicMock, patch

import pytest

from backend.config import Settings
from backend.session_manager import SESSION_TTL_SECONDS, Session, SessionManager


@pytest.fixture()
def mock_settings():
    return Settings(
        openai_api_key="sk-test",
        model_name="gpt-4o-mini",
        chunk_size=500,
        chunk_overlap=100,
        max_context_tokens=4000,
        host="127.0.0.1",
        port=8765,
        cors_origins=["*"],
        ollama_base_url="http://localhost:11434",
        fallback_model="gemma2:9b",
        multilingual_model="qwen2.5:7b",
    )


@pytest.fixture()
def mock_session():
    return Session(
        session_id="abc123",
        url="https://example.com",
        title="Example",
        vectorstore=MagicMock(),
        chat_session=MagicMock(),
        chunk_count=10,
    )


class TestSession:
    def test_touch_updates_last_active(self, mock_session):
        original = mock_session.last_active
        time.sleep(0.01)
        mock_session.touch()
        assert mock_session.last_active > original


class TestSessionManager:
    @patch("backend.session_manager.ChatSession")
    @patch("backend.session_manager.build_vectorstore")
    def test_create_and_get_session(
        self, mock_build_vs, mock_chat_session_cls, mock_settings
    ):
        mock_vs = MagicMock()
        mock_vs.index.ntotal = 5
        mock_build_vs.return_value = mock_vs
        mock_chat_session_cls.return_value = MagicMock()

        manager = SessionManager(mock_settings)
        session = manager.create_session("s1", "https://ex.com", "Ex", "some text")

        assert session.session_id == "s1"
        assert session.chunk_count == 5

        retrieved = manager.get_session("s1")
        assert retrieved is session

    def test_get_nonexistent_session(self, mock_settings):
        manager = SessionManager(mock_settings)
        assert manager.get_session("nope") is None

    @patch("backend.session_manager.ChatSession")
    @patch("backend.session_manager.build_vectorstore")
    def test_delete_session(self, mock_build_vs, mock_chat_session_cls, mock_settings):
        mock_vs = MagicMock()
        mock_vs.index.ntotal = 3
        mock_build_vs.return_value = mock_vs
        mock_chat_session_cls.return_value = MagicMock()

        manager = SessionManager(mock_settings)
        manager.create_session("s1", "https://ex.com", "Ex", "text")
        manager.delete_session("s1")
        assert manager.get_session("s1") is None

    @patch("backend.session_manager.ChatSession")
    @patch("backend.session_manager.build_vectorstore")
    def test_evicts_stale_sessions(
        self, mock_build_vs, mock_chat_session_cls, mock_settings
    ):
        mock_vs = MagicMock()
        mock_vs.index.ntotal = 1
        mock_build_vs.return_value = mock_vs
        mock_chat_session_cls.return_value = MagicMock()

        manager = SessionManager(mock_settings)
        session = manager.create_session("old", "https://ex.com", "Ex", "text")
        # Artificially age the session
        session.last_active = time.time() - SESSION_TTL_SECONDS - 1

        # Creating a new session triggers eviction
        manager.create_session("new", "https://ex2.com", "Ex2", "text2")
        assert manager.get_session("old") is None
        assert manager.get_session("new") is not None
