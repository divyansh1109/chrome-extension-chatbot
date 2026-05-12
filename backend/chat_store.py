"""SQLite-backed chat history and tab registry."""

from __future__ import annotations

import json
import logging
import time

import aiosqlite

logger = logging.getLogger(__name__)

DB_PATH = "chatbot.db"

# Sessions older than this are eligible for cleanup
HISTORY_TTL_SECONDS = 30 * 60  # 30 minutes (matches session TTL)


async def init_db(db_path: str = DB_PATH) -> None:
    """Create tables if they don't exist. Call once at app startup."""
    async with aiosqlite.connect(db_path) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS chat_history (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id  TEXT    NOT NULL,
                role        TEXT    NOT NULL,
                text        TEXT    NOT NULL,
                sources     TEXT    DEFAULT '[]',
                created_at  REAL   NOT NULL
            )
        """)
        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_chat_session
            ON chat_history(session_id)
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS tab_registry (
                tab_id      TEXT PRIMARY KEY,
                session_id  TEXT NOT NULL,
                url         TEXT NOT NULL,
                title       TEXT NOT NULL DEFAULT '',
                indexed     INTEGER NOT NULL DEFAULT 1,
                last_active REAL NOT NULL
            )
        """)
        await db.commit()
    logger.info("SQLite database initialized at %s", db_path)


async def save_messages(
    session_id: str,
    messages: list[dict],
    db_path: str = DB_PATH,
) -> None:
    """Append chat messages to the history table."""
    now = time.time()
    async with aiosqlite.connect(db_path) as db:
        for msg in messages:
            await db.execute(
                """INSERT INTO chat_history (session_id, role, text, sources, created_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (
                    session_id,
                    msg["role"],
                    msg["text"],
                    json.dumps(msg.get("sources", [])),
                    now,
                ),
            )
        await db.commit()


async def get_history(
    session_id: str,
    db_path: str = DB_PATH,
) -> list[dict]:
    """Retrieve chat history for a session, ordered chronologically."""
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """SELECT role, text, sources FROM chat_history
               WHERE session_id = ? ORDER BY id ASC""",
            (session_id,),
        )
        rows = await cursor.fetchall()
        return [
            {
                "role": row["role"],
                "text": row["text"],
                "sources": json.loads(row["sources"]),
            }
            for row in rows
        ]


async def clear_history(session_id: str, db_path: str = DB_PATH) -> None:
    """Delete chat history for a specific session."""
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            "DELETE FROM chat_history WHERE session_id = ?", (session_id,)
        )
        await db.commit()


# ── Tab Registry ──────────────────────────────────────────────


async def register_tab(
    tab_id: str,
    session_id: str,
    url: str,
    title: str = "",
    indexed: bool = True,
    db_path: str = DB_PATH,
) -> None:
    """Register or update a tab in the registry."""
    now = time.time()
    idx = 1 if indexed else 0
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            """INSERT INTO tab_registry (tab_id, session_id, url, title, indexed, last_active)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(tab_id) DO UPDATE SET
                 session_id = CASE WHEN excluded.session_id != '' THEN excluded.session_id ELSE tab_registry.session_id END,
                 url = excluded.url,
                 title = excluded.title,
                 indexed = CASE WHEN excluded.indexed = 1 THEN 1 ELSE tab_registry.indexed END,
                 last_active = excluded.last_active
            """,
            (tab_id, session_id, url, title, idx, now),
        )
        await db.commit()


async def unregister_tab(tab_id: str, db_path: str = DB_PATH) -> None:
    """Remove a tab from the registry (called on tab close)."""
    async with aiosqlite.connect(db_path) as db:
        await db.execute("DELETE FROM tab_registry WHERE tab_id = ?", (tab_id,))
        await db.commit()


async def get_all_tabs(db_path: str = DB_PATH) -> list[dict]:
    """Return all registered tabs."""
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT tab_id, session_id, url, title, indexed FROM tab_registry"
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


# ── Cleanup / TTL ─────────────────────────────────────────────


async def cleanup_stale(
    ttl_seconds: float = HISTORY_TTL_SECONDS, db_path: str = DB_PATH
) -> int:
    """Delete chat history and tab entries older than TTL. Returns count deleted."""
    cutoff = time.time() - ttl_seconds
    total = 0
    async with aiosqlite.connect(db_path) as db:
        # Get stale session IDs
        cursor = await db.execute(
            "SELECT DISTINCT session_id FROM chat_history WHERE created_at < ?",
            (cutoff,),
        )
        stale_sessions = [row[0] for row in await cursor.fetchall()]

        if stale_sessions:
            placeholders = ",".join("?" * len(stale_sessions))
            result = await db.execute(
                f"DELETE FROM chat_history WHERE session_id IN ({placeholders})",
                stale_sessions,
            )
            total += result.rowcount

        # Clean stale tab entries
        result = await db.execute(
            "DELETE FROM tab_registry WHERE last_active < ?", (cutoff,)
        )
        total += result.rowcount

        await db.commit()

    if total:
        logger.info("Cleanup: removed %d stale rows (TTL=%ds)", total, ttl_seconds)
    return total
