"""LangChain conversational retrieval using modern LCEL Runnables."""

from __future__ import annotations

from typing import Any

from langchain_community.vectorstores import FAISS
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.runnables import RunnablePassthrough
from langchain_openai import ChatOpenAI, OpenAIEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter

from backend.config import Settings

SYSTEM_PROMPT = (
    "You are a helpful assistant that answers questions about the content "
    "of a specific webpage the user is viewing. Use ONLY the context below "
    "to answer. If the answer is not in the context, say so honestly.\n\n"
    "Context:\n{context}"
)


def build_vectorstore(
    text: str,
    settings: Settings,
) -> FAISS:
    """Split page text into chunks and create an in-memory FAISS index."""
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=settings.chunk_size,
        chunk_overlap=settings.chunk_overlap,
        separators=["\n\n", "\n", ". ", " ", ""],
    )
    chunks = splitter.split_text(text)
    if not chunks:
        chunks = ["No meaningful content was found on this page."]

    embeddings = OpenAIEmbeddings(
        openai_api_key=settings.openai_api_key,
        model="text-embedding-3-small",
    )
    return FAISS.from_texts(chunks, embeddings)


class ChatSession:
    """Wraps a retriever + LLM chain with conversation memory."""

    def __init__(self, vectorstore: FAISS, settings: Settings) -> None:
        self.vectorstore = vectorstore
        self.retriever = vectorstore.as_retriever(
            search_type="similarity",
            search_kwargs={"k": 4},
        )
        self.llm = ChatOpenAI(
            openai_api_key=settings.openai_api_key,
            model_name=settings.model_name,
            temperature=0.3,
        )
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

