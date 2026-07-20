import { useState, useRef, useEffect } from 'react';
import MessageBubble from './MessageBubble';

export default function ChatRoom({
  user,
  messages,
  decryptedTexts,
  members,
  onlineInRoom,
  typingUsers,
  onSend,
  onTypingStart,
  onTypingStop,
  roomName,
  rotationRequired,
  canInvite,
  onInvite,
}) {
  const [input, setInput] = useState('');
  const messagesEndRef = useRef(null);
  const typingTimeoutRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, decryptedTexts]);

  function handleInputChange(e) {
    setInput(e.target.value);
    onTypingStart();
    clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(onTypingStop, 2000);
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (!input.trim()) return;
    onSend(input);
    setInput('');
    onTypingStop();
    clearTimeout(typingTimeoutRef.current);
  }

  const typingOthers = typingUsers.filter((u) => u.userId !== user.id);

  return (
    <div className="chat-room">
      <div className="chat-header">
        <div className="chat-header-main">
          <div>
            <h2>{roomName || 'Pokój czatu'}</h2>
            <span className="e2e-badge">🔒 E2E zaszyfrowane</span>
          </div>
          {canInvite && <button className="invite-button" onClick={onInvite} title="Zaproś użytkowników">
            <span aria-hidden="true">+</span> Zaproś
          </button>}
        </div>
        <div className="online-list">
          <span className="online-label">Online ({onlineInRoom.length}/{members.length}):</span>
          {members.map((m) => (
            <span
              key={m.id}
              className={`member-chip ${onlineInRoom.includes(m.id) ? 'online' : 'offline'}`}
              title={onlineInRoom.includes(m.id) ? 'Online' : 'Offline'}
            >
              <span className="status-dot" />
              {m.username}
              {m.id === user.id && ' (Ty)'}
            </span>
          ))}
        </div>
      </div>

      <div className="messages-area">
        {messages.length === 0 && (
          <div className="empty-chat">
            <p>Brak wiadomości. Napisz coś — serwer zobaczy tylko zaszyfrowany tekst.</p>
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            text={decryptedTexts[msg.id]}
            isOwn={msg.senderId === user.id}
            members={members}
            currentUserId={user.id}
          />
        ))}
        {typingOthers.length > 0 && (
          <div className="typing-indicator">
            {typingOthers.map((u) => u.username).join(', ')}{' '}
            {typingOthers.length === 1 ? 'pisze' : 'piszą'}...
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <form className="message-input" onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder={rotationRequired ? 'Trwa zmiana klucza pokoju...' : 'Napisz wiadomość (szyfrowana E2E)...'}
          value={input}
          onChange={handleInputChange}
          maxLength={2000}
        />
        <button type="submit" disabled={!input.trim() || rotationRequired}>
          Wyślij
        </button>
      </form>
    </div>
  );
}
