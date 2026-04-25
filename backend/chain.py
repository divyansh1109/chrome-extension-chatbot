"""LangChain conversational retrieval using modern LCEL Runnables."""

from __future__ import annotations

import logging
from collections.abc import Generator
from typing import Any

from langchain_community.vectorstores import FAISS
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.runnables import RunnablePassthrough
from langchain_ollama import ChatOllama
from langchain_openai import ChatOpenAI, OpenAIEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter

from backend.config import Settings

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "You are a helpful assistant that answers questions about the content "
    "of a specific webpage the user is viewing. Ground your answers in the "
    "context below, but you may also use your general knowledge to provide "
    "comparisons, explanations, or opinions when the user asks. Always start "
    "by stating what the page does or does not cover, then supplement with "
    "your own knowledge clearly marked as such (e.g. 'From my general "
    "knowledge: …'). If the context has no relevant information at all, "
    "say so before answering.\n\n"
    "Context:\n{context}"
)

# JSON-LD @type values that carry useful product / item data
_USEFUL_LD_TYPES = {
    "Product", "Offer", "AggregateOffer", "AggregateRating", "Review",
    "BreadcrumbList", "ItemList", "ListItem", "Brand", "Organization",
    "LocalBusiness", "Recipe", "Article", "NewsArticle", "FAQPage",
    "Question", "Answer", "HowTo", "Event", "Course", "Book",
    "SoftwareApplication", "VideoObject", "Movie",
}


def format_structured_data(items: list[dict[str, Any]]) -> str:
    """Convert JSON-LD items into a flat, readable text block for indexing."""
    lines: list[str] = []
    for item in items:
        ld_type = item.get("@type", "")
        # Normalise: @type can be a list
        if isinstance(ld_type, list):
            ld_type = ", ".join(ld_type)
        lines.append(f"[Structured Data — {ld_type or 'Unknown'}]")
        _flatten(item, lines, indent=0)
        lines.append("")  # blank separator
    return "\n".join(lines)


def _flatten(
    obj: Any,
    lines: list[str],
    indent: int = 0,
    key_prefix: str = "",
) -> None:
    """Recursively flatten a JSON-LD object into human-readable lines."""
    prefix = "  " * indent
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k.startswith("@") and k not in ("@type",):
                continue  # skip @context, @id, etc.
            label = f"{key_prefix}{k}" if not key_prefix else f"{key_prefix}.{k}"
            if isinstance(v, (dict, list)):
                _flatten(v, lines, indent, label)
            else:
                lines.append(f"{prefix}{label}: {v}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            _flatten(v, lines, indent, f"{key_prefix}[{i}]")
    else:
        lines.append(f"{prefix}{key_prefix}: {obj}")


def build_llm(settings: Settings, *, multilingual: bool = False) -> BaseChatModel:
    """Build the LLM with a waterfall fallback chain.

    Primary:   OpenAI (gpt-4o-mini or configured model)
    Fallback:  Gemma 2 9B via Ollama (general) OR Qwen2.5 7B (multilingual)

    If *multilingual* is True the Qwen model is inserted as the first
    fallback so non-English pages get a model that excels at them.
    """
    openai = ChatOpenAI(
        openai_api_key=settings.openai_api_key,
        model_name=settings.model_name,
        temperature=0.3,
    )

    gemma = ChatOllama(
        model=settings.fallback_model,
        base_url=settings.ollama_base_url,
        temperature=0.3,
    )
    qwen = ChatOllama(
        model=settings.multilingual_model,
        base_url=settings.ollama_base_url,
        temperature=0.3,
    )

    primary = openai

    if multilingual:
        fallbacks = [qwen, gemma]
    else:
        fallbacks = [gemma, qwen]

    return primary.with_fallbacks(fallbacks)


def build_vectorstore(
    text: str,
    settings: Settings,
    structured_data: list[dict[str, Any]] | None = None,
) -> FAISS:
    """Split page text into chunks and create an in-memory FAISS index.

    If structured_data (JSON-LD) is provided, it is formatted as readable
    text and prepended so the retriever can surface clean product/item info.
    """
    parts: list[str] = []
    if structured_data:
        parts.append(format_structured_data(structured_data))
    parts.append(text)
    combined = "\n\n".join(parts)

    splitter = RecursiveCharacterTextSplitter(
        chunk_size=settings.chunk_size,
        chunk_overlap=settings.chunk_overlap,
        separators=["\n\n", "\n", ". ", " ", ""],
    )
    chunks = splitter.split_text(combined)
    if not chunks:
        chunks = ["No meaningful content was found on this page."]

    # Cap chunks to avoid excessive embedding API calls on huge pages
    MAX_CHUNKS = 30
    if len(chunks) > MAX_CHUNKS:
        chunks = chunks[:MAX_CHUNKS]

    embeddings = OpenAIEmbeddings(
        openai_api_key=settings.openai_api_key,
        model="text-embedding-3-small",
    )
    return FAISS.from_texts(chunks, embeddings)


class ChatSession:
    """Wraps a retriever + LLM chain with conversation memory."""

    def __init__(
        self,
        vectorstore: FAISS,
        settings: Settings,
        *,
        multilingual: bool = False,
    ) -> None:
        self.vectorstore = vectorstore
        self.retriever = vectorstore.as_retriever(
            search_type="similarity",
            search_kwargs={"k": 4},
        )
        self.llm = build_llm(settings, multilingual=multilingual)
        self.chat_history: list[HumanMessage | AIMessage] = []
        self._max_history = 20  # keep last 20 messages (10 turns)

        self.prompt = ChatPromptTemplate.from_messages([
            ("system", SYSTEM_PROMPT),
            MessagesPlaceholder("chat_history"),
            ("human", "{question}"),
        ])
        self.chain = (
            {
                "context": lambda x: self._retrieve(x["question"]),
                "chat_history": lambda x: x["chat_history"],
                "question": lambda x: x["question"],
            }
            | self.prompt
            | self.llm
            | StrOutputParser()
        )

    def _retrieve(self, question: str) -> str:
        """Retrieve relevant docs and format as a single context string."""
        docs = self.retriever.invoke(question)
        self._last_sources = [doc.page_content[:200] for doc in docs]
        return "\n\n".join(doc.page_content for doc in docs)

    def invoke(self, question: str) -> dict[str, Any]:
        """Run the chain and manage chat history."""
        self._last_sources = []
        answer = self.chain.invoke({
            "question": question,
            "chat_history": self.chat_history,
        })
        # Update history
        self.chat_history.append(HumanMessage(content=question))
        self.chat_history.append(AIMessage(content=answer))
        # Trim history
        if len(self.chat_history) > self._max_history:
            self.chat_history = self.chat_history[-self._max_history:]

        return {
            "answer": answer,
            "source_documents": self._last_sources,
        }

    def stream(self, question: str) -> Generator[str, None, dict[str, Any]]:
        """Stream tokens from the chain, then return final metadata.

        Yields individual token strings.  After the generator is exhausted,
        call ``generator.send(None)`` or catch ``StopIteration`` to get the
        return value containing ``answer`` and ``source_documents``.
        """
        self._last_sources = []
        chunks: list[str] = []
        for token in self.chain.stream({
            "question": question,
            "chat_history": self.chat_history,
        }):
            chunks.append(token)
            yield token

        answer = "".join(chunks)
        # Update history
        self.chat_history.append(HumanMessage(content=question))
        self.chat_history.append(AIMessage(content=answer))
        if len(self.chat_history) > self._max_history:
            self.chat_history = self.chat_history[-self._max_history:]

        return {
            "answer": answer,
            "source_documents": self._last_sources,
        }

