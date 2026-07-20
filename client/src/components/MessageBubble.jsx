export default function MessageBubble({ message, text, isOwn, members, currentUserId }) {
  const readers = (message.readBy || []).filter((r) => r.userId !== message.senderId);
  const allRead =
    members.length > 1 &&
    members
      .filter((m) => m.id !== message.senderId)
      .every((m) => readers.some((r) => r.userId === m.id));

  const time = new Date(message.timestamp).toLocaleTimeString('pl-PL', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className={`message ${isOwn ? 'own' : 'other'}`}>
      {!isOwn && <span className="sender-name">{message.senderUsername}</span>}
      <div className="bubble">
        <p>{text || '...'}</p>
        <div className="message-meta">
          <span className="time">{time}</span>
          {isOwn && (
            <span className={`read-status ${allRead ? 'all-read' : ''}`} title={getReadTooltip(readers)}>
              {allRead ? '✓✓' : readers.length > 0 ? '✓✓' : '✓'}
            </span>
          )}
        </div>
      </div>
      {isOwn && readers.length > 0 && (
        <div className="read-by">
          Odczytano przez: {readers.map((r) => r.username).join(', ')}
        </div>
      )}
    </div>
  );
}

function getReadTooltip(readers) {
  if (readers.length === 0) return 'Wysłano';
  return `Odczytano przez: ${readers.map((r) => r.username).join(', ')}`;
}
