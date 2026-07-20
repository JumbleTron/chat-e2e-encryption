import { useState, useEffect, useRef } from 'react';
import LoginScreen from './components/LoginScreen';
import ChatRoom from './components/ChatRoom';
import CreateRoomModal from './components/CreateRoomModal';
import DevicesModal from './components/DevicesModal';
import InviteMembersModal from './components/InviteMembersModal';
import { useChat } from './hooks/useChat';
import { loadSession, clearSession } from './crypto';
import { closeMls } from './mls/client';

export default function App() {
  const [user, setUser] = useState(null);
  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const [showDevices, setShowDevices] = useState(false);
  const [showInviteMembers, setShowInviteMembers] = useState(false);
  const [restoringSession, setRestoringSession] = useState(true);
  const sessionRestoreStarted = useRef(false);
  const chat = useChat(user);

  useEffect(() => {
    if (sessionRestoreStarted.current) return;
    sessionRestoreStarted.current = true;
    const session = loadSession();
    if (!session) {
      setRestoringSession(false);
      return;
    }
    setUser(session);
    setRestoringSession(false);
  }, []);

  useEffect(() => {
    if (!user) return;
    chat.refreshRooms();
  }, [user]);

  async function handleLogout() {
    await closeMls();
    clearSession();
    setUser(null);
  }

  const activeRoomData = chat.rooms.find((r) => r.id === chat.activeRoom);

  return (
    <div className="app">
      {restoringSession ? (
        <div className="session-loading">Otwieranie bezpiecznej sesji...</div>
      ) : !user ? (
        <LoginScreen onLogin={setUser} />
      ) : (
        <div className="layout">
          <aside className="sidebar">
            <div className="sidebar-header">
              <div className="user-info">
                <span className="avatar">{user.username[0].toUpperCase()}</span>
                <div>
                  <strong>{user.username}</strong>
                  <span className="user-status online">● Online</span>
                </div>
              </div>
              <button className="btn-logout" onClick={handleLogout} title="Wyloguj">
                ⏻
              </button>
            </div>

            <button className="btn-new-room" onClick={() => setShowCreateRoom(true)}>
              + Nowy pokój
            </button>
            <button className="btn-devices" onClick={() => setShowDevices(true)}>
              Urządzenia
            </button>

            <div className="rooms-list">
              <h3>Pokoje</h3>
              {chat.rooms.length === 0 && (
                <p className="empty-rooms">Brak pokoi. Utwórz pierwszy!</p>
              )}
              {chat.rooms.map((room) => (
                <button
                  key={room.id}
                  className={`room-item ${chat.activeRoom === room.id ? 'active' : ''}`}
                  onClick={() => chat.joinRoom(room.id)}
                >
                  <span className="room-name"># {room.name}</span>
                  <span className="room-meta">{room.memberCount} członków</span>
                </button>
              ))}
            </div>

            <div className="sidebar-footer">
              {chat.securityError && <p className="error">{chat.securityError}</p>}
              <p>🌐 Online globalnie: {chat.globalOnline.length}</p>
            </div>
          </aside>

          <main className="main-content">
            {chat.activeRoom ? (
              <ChatRoom
                user={user}
                messages={chat.messages}
                decryptedTexts={chat.decryptedTexts}
                members={chat.members}
                onlineInRoom={chat.onlineInRoom}
                typingUsers={chat.typingUsers}
                onSend={chat.sendMessage}
                onTypingStart={chat.startTyping}
                onTypingStop={chat.stopTyping}
                roomName={activeRoomData?.name}
                rotationRequired={chat.rotationRequired}
                canInvite={activeRoomData?.creatorId === user.id}
                onInvite={() => setShowInviteMembers(true)}
              />
            ) : (
              <div className="no-room-selected">
                <h2>Wybierz pokój lub utwórz nowy</h2>
                <p>Wiadomości są szyfrowane end-to-end. Serwer nie ma dostępu do treści.</p>
              </div>
            )}
          </main>
        </div>
      )}

      {showCreateRoom && user && (
        <CreateRoomModal
          user={user}
          onClose={() => setShowCreateRoom(false)}
          onCreated={async (roomId) => {
            setShowCreateRoom(false);
            await chat.refreshRooms();
            await chat.joinRoom(roomId);
          }}
        />
      )}

      {showDevices && user && (
        <DevicesModal
          currentDeviceId={user.deviceId}
          onClose={() => setShowDevices(false)}
          onKeysRotated={() => {
            chat.refreshRooms();
            if (chat.activeRoom) chat.joinRoom(chat.activeRoom);
          }}
        />
      )}

      {showInviteMembers && user && chat.activeRoom && (
        <InviteMembersModal
          roomId={chat.activeRoom}
          members={chat.members}
          onClose={() => setShowInviteMembers(false)}
          onInvited={() => {
            setShowInviteMembers(false);
            chat.refreshRooms();
            chat.joinRoom(chat.activeRoom);
          }}
        />
      )}
    </div>
  );
}
