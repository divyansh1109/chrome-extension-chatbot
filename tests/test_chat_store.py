"""Tests for the SQLite-backed chat_store module."""

import asyncio

import pytest

from backend import chat_store


@pytest.fixture()
def db_path(tmp_path):
    """Provide a fresh SQLite database path and initialize it."""
    import asyncio
    path = str(tmp_path / "test.db")
    loop = asyncio.new_event_loop()
    loop.run_until_complete(chat_store.init_db(path))
    loop.close()
    return path


class TestChatHistory:
    @pytest.mark.asyncio
    async def test_save_and_get_history(self, db_path):
        msgs = [
            {"role": "user", "text": "Hello"},
            {"role": "assistant", "text": "Hi there!", "sources": ["s1"]},
        ]
        await chat_store.save_messages("sess1", msgs, db_path=db_path)

        history = await chat_store.get_history("sess1", db_path=db_path)
        assert len(history) == 2
        assert history[0]["role"] == "user"
        assert history[0]["text"] == "Hello"
        assert history[1]["sources"] == ["s1"]

    @pytest.mark.asyncio
    async def test_get_empty_history(self, db_path):
        history = await chat_store.get_history("nonexistent", db_path=db_path)
        assert history == []

    @pytest.mark.asyncio
    async def test_sessions_are_isolated(self, db_path):
        await chat_store.save_messages("s1", [{"role": "user", "text": "A"}], db_path=db_path)
        await chat_store.save_messages("s2", [{"role": "user", "text": "B"}], db_path=db_path)

        h1 = await chat_store.get_history("s1", db_path=db_path)
        h2 = await chat_store.get_history("s2", db_path=db_path)
        assert len(h1) == 1 and h1[0]["text"] == "A"
        assert len(h2) == 1 and h2[0]["text"] == "B"

    @pytest.mark.asyncio
    async def test_clear_history(self, db_path):
        await chat_store.save_messages("s1", [{"role": "user", "text": "X"}], db_path=db_path)
        await chat_store.clear_history("s1", db_path=db_path)
        history = await chat_store.get_history("s1", db_path=db_path)
        assert history == []


class TestTabRegistry:
    @pytest.mark.asyncio
    async def test_register_and_list_tabs(self, db_path):
        await chat_store.register_tab("1", "sess1", "https://a.com", "Tab A", db_path=db_path)
        await chat_store.register_tab("2", "sess2", "https://b.com", "Tab B", db_path=db_path)

        tabs = await chat_store.get_all_tabs(db_path=db_path)
        assert len(tabs) == 2
        urls = {t["url"] for t in tabs}
        assert urls == {"https://a.com", "https://b.com"}

    @pytest.mark.asyncio
    async def test_unregister_tab(self, db_path):
        await chat_store.register_tab("1", "sess1", "https://a.com", db_path=db_path)
        await chat_store.unregister_tab("1", db_path=db_path)
        tabs = await chat_store.get_all_tabs(db_path=db_path)
        assert len(tabs) == 0

    @pytest.mark.asyncio
    async def test_register_upserts(self, db_path):
        await chat_store.register_tab("1", "old", "https://old.com", db_path=db_path)
        await chat_store.register_tab("1", "new", "https://new.com", db_path=db_path)
        tabs = await chat_store.get_all_tabs(db_path=db_path)
        assert len(tabs) == 1
        assert tabs[0]["session_id"] == "new"
        assert tabs[0]["url"] == "https://new.com"


class TestCleanup:
    @pytest.mark.asyncio
    async def test_cleanup_removes_stale(self, db_path):
        # Save messages, then clean with a tiny TTL
        await chat_store.save_messages("old", [{"role": "user", "text": "bye"}], db_path=db_path)
        await chat_store.register_tab("1", "old", "https://old.com", db_path=db_path)

        deleted = await chat_store.cleanup_stale(ttl_seconds=0, db_path=db_path)
        assert deleted >= 2  # at least 1 chat row + 1 tab row

        assert await chat_store.get_history("old", db_path=db_path) == []
        assert await chat_store.get_all_tabs(db_path=db_path) == []

    @pytest.mark.asyncio
    async def test_cleanup_keeps_recent(self, db_path):
        await chat_store.save_messages("new", [{"role": "user", "text": "hi"}], db_path=db_path)
        await chat_store.register_tab("1", "new", "https://new.com", db_path=db_path)

        deleted = await chat_store.cleanup_stale(ttl_seconds=3600, db_path=db_path)
        assert deleted == 0
        assert len(await chat_store.get_history("new", db_path=db_path)) == 1
        assert len(await chat_store.get_all_tabs(db_path=db_path)) == 1
