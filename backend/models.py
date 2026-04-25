"""Pydantic models for API request/response validation."""

from typing import Any

from pydantic import BaseModel, Field


class PageContent(BaseModel):
    """Payload sent from the extension when a page is loaded or refreshed."""

    url: str = Field(..., description="The URL of the current page")
    title: str = Field("", description="Page title")
    text_content: str = Field(..., description="Extracted text from the page")
    structured_data: list[dict[str, Any]] | None = Field(
        None,
        description="JSON-LD structured data extracted from <script type='application/ld+json'> blocks",
    )
    language: str = Field(
        "",
        description="Page language from document.documentElement.lang (e.g. 'en', 'zh', 'ja')",
    )


class ChatRequest(BaseModel):
    """A single chat turn from the user."""

    session_id: str = Field(..., description="Unique session identifier")
    question: str = Field(..., min_length=1, max_length=4000)


class ChatResponse(BaseModel):
    """Response returned to the extension."""

    answer: str
    session_id: str
    sources: list[str] = Field(
        default_factory=list,
        description="Relevant text chunks used to answer",
    )


class SessionInfo(BaseModel):
    """Metadata about an active session."""

    session_id: str
    url: str
    title: str
    chunk_count: int
