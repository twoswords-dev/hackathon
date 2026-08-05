import { useRef, useEffect, useState, FormEvent } from "react";
import type { ChatMessage } from "../types";
import "./ChatPanel.css";

interface ChatPanelProps {
  messages: ChatMessage[];
  isDmThinking: boolean;
  onSendMessage: (text: string) => void;
}

export default function ChatPanel({ messages, isDmThinking, onSendMessage }: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, isDmThinking]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    onSendMessage(text);
    setDraft("");
  };

  return (
    <section className="chat-panel">
      <header className="chat-panel__header">
        <h2>Party Chat</h2>
      </header>

      <div className="chat-panel__messages" ref={scrollRef}>
        {messages.length === 0 && (
          <p className="chat-panel__empty">The torches flicker. Speak to begin your quest...</p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`chat-bubble chat-bubble--${m.role}`}>
            <span className="chat-bubble__author">{m.role === "dm" ? "Dungeon Master" : "You"}</span>
            <p className="chat-bubble__text">{m.text}</p>
          </div>
        ))}
        {isDmThinking && (
          <div className="chat-bubble chat-bubble--dm chat-bubble--thinking">
            <span className="chat-bubble__author">Dungeon Master</span>
            <p className="chat-bubble__text">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
            </p>
          </div>
        )}
      </div>

      <form className="chat-panel__input" onSubmit={handleSubmit}>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="What do you do?"
          aria-label="Message"
        />
        <button type="submit" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}
