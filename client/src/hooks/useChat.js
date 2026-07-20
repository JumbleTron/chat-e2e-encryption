import { useEffect, useRef, useState, useCallback } from 'react';
import { io } from 'socket.io-client';
import { apiFetch } from '../api';
import {
  decryptMessage,
  encryptMessage,
  encryptGroupKeyForUser,
  exportPublicKey,
  generateAuthToken,
  generateKeyPair,
  getRoomGroupKeys,
  importGroupKey,
  loadPrivateKey,
  saveKeys,
  saveRoomGroupKey,
  decryptGroupKey,
  saveSession,
  clearSession,
} from '../crypto';

export function useChat(user) {
  const socketRef = useRef(null);
  const [rooms, setRooms] = useState([]);
  const [activeRoom, setActiveRoom] = useState(null);
  const [messages, setMessages] = useState([]);
  const [members, setMembers] = useState([]);
  const [onlineInRoom, setOnlineInRoom] = useState([]);
  const [globalOnline, setGlobalOnline] = useState([]);
  const [typingUsers, setTypingUsers] = useState([]);
  const [decryptedTexts, setDecryptedTexts] = useState({});
  const [currentEpoch, setCurrentEpoch] = useState(1);
  const [rotationRequired, setRotationRequired] = useState(false);
  const roomKeysRef = useRef(new Map());
  const privateKeyRef = useRef(null);
  const activeRoomRef = useRef(null);

  useEffect(() => { activeRoomRef.current = activeRoom; }, [activeRoom]);

  const decryptAndStore = useCallback(async (msg, keys = roomKeysRef.current) => {
    const groupKey = keys.get(msg.keyEpoch || 1);
    if (!groupKey) {
      setDecryptedTexts((prev) => ({ ...prev, [msg.id]: '[brak klucza dla tej wiadomości]' }));
      return null;
    }
    try {
      const text = await decryptMessage(msg.ciphertext, msg.iv, groupKey);
      setDecryptedTexts((prev) => ({ ...prev, [msg.id]: text }));
      return text;
    } catch {
      setDecryptedTexts((prev) => ({ ...prev, [msg.id]: '[nie udało się odszyfrować]' }));
      return null;
    }
  }, []);

  const markAsRead = useCallback((messageId) => {
    if (!socketRef.current || !activeRoomRef.current || !user) return;
    socketRef.current.emit('message:read', { roomId: activeRoomRef.current, messageId });
  }, [user]);

  const importStoredKeys = useCallback(async (roomId) => {
    const imported = new Map();
    for (const [epoch, rawKey] of Object.entries(getRoomGroupKeys(roomId))) {
      imported.set(Number(epoch), await importGroupKey(rawKey));
    }
    roomKeysRef.current = imported;
    return imported;
  }, []);

  useEffect(() => {
    if (!user?.deviceId || !user?.authToken) return;
    let disposed = false;
    let socket;

    async function connect() {
      privateKeyRef.current = await loadPrivateKey();
      if (disposed) return;
      socket = io({
        transports: ['websocket'],
        auth: { deviceId: user.deviceId, token: user.authToken },
      });
      socketRef.current = socket;

      socket.on('presence:update', (ids) => setGlobalOnline(ids));
      socket.on('connect_error', (error) => {
        if (error.message === 'Unauthorized device') {
          clearSession();
          window.location.reload();
        }
      });

      socket.on('room:history', async ({
        roomId, messages: history, members: roomMembers, encryptedGroupKeys,
        currentEpoch: epoch, rotationRequired: needsRotation,
      }) => {
        const keys = await importStoredKeys(roomId);
        for (const wrapped of encryptedGroupKeys || []) {
          if (!keys.has(wrapped.keyEpoch) && privateKeyRef.current) {
            const raw = await decryptGroupKey(wrapped.encryptedGroupKey, privateKeyRef.current);
            saveRoomGroupKey(roomId, raw, wrapped.keyEpoch);
            keys.set(wrapped.keyEpoch, await importGroupKey(raw));
          }
        }
        roomKeysRef.current = keys;
        setCurrentEpoch(epoch || 1);
        setRotationRequired(needsRotation);
        setMembers(roomMembers);
        setMessages(history);
        for (const msg of history) {
          const text = await decryptAndStore(msg, keys);
          if (text !== null && msg.senderId !== user.id) markAsRead(msg.id);
        }
      });

      socket.on('message:new', async (msg) => {
        setMessages((prev) => prev.some((item) => item.id === msg.id) ? prev : [...prev, msg]);
        const text = await decryptAndStore(msg);
        if (text !== null && msg.senderId !== user.id && activeRoomRef.current === msg.roomId) {
          markAsRead(msg.id);
        }
      });

      socket.on('message:read-update', ({ messageId, readBy }) => {
        setMessages((prev) => prev.map((msg) => msg.id === messageId ? { ...msg, readBy } : msg));
      });
      socket.on('room:member-joined', ({ members: roomMembers }) => setMembers(roomMembers));
      socket.on('room:members-updated', ({ roomId, members: roomMembers }) => {
        if (activeRoomRef.current === roomId) setMembers(roomMembers);
        fetchRooms();
      });
      socket.on('room:invited', () => fetchRooms());
      socket.on('room:online', ({ onlineUserIds }) => setOnlineInRoom(onlineUserIds));
      socket.on('typing:start', ({ userId, username }) => {
        setTypingUsers((prev) => prev.some((item) => item.userId === userId)
          ? prev : [...prev, { userId, username }]);
      });
      socket.on('typing:stop', ({ userId }) => {
        setTypingUsers((prev) => prev.filter((item) => item.userId !== userId));
      });

      socket.on('room:key-needed', async ({ roomId, requesterDeviceId, requesterPublicKey }) => {
        if (requesterDeviceId === user.deviceId) return;
        const encryptedGroupKeys = [];
        for (const [epoch, rawKey] of Object.entries(getRoomGroupKeys(roomId))) {
          encryptedGroupKeys.push({
            keyEpoch: Number(epoch),
            encryptedGroupKey: await encryptGroupKeyForUser(rawKey, requesterPublicKey),
          });
        }
        if (encryptedGroupKeys.length) {
          socket.emit('room:share-key', { roomId, targetDeviceId: requesterDeviceId, encryptedGroupKeys });
        }
      });

      async function receiveKeys(roomId, encryptedGroupKeys) {
        for (const wrapped of encryptedGroupKeys || []) {
          const raw = await decryptGroupKey(wrapped.encryptedGroupKey, privateKeyRef.current);
          saveRoomGroupKey(roomId, raw, wrapped.keyEpoch);
          if (activeRoomRef.current === roomId) {
            roomKeysRef.current.set(wrapped.keyEpoch, await importGroupKey(raw));
          }
        }
        if (activeRoomRef.current === roomId) {
          setMessages((current) => {
            current.forEach((msg) => decryptAndStore(msg));
            return current;
          });
        }
      }

      socket.on('room:key-received', ({ roomId, encryptedGroupKeys }) => receiveKeys(roomId, encryptedGroupKeys));
      socket.on('room:key-rotated', async ({ roomId, keyEpoch, encryptedGroupKey }) => {
        await receiveKeys(roomId, [{ keyEpoch, encryptedGroupKey }]);
        if (activeRoomRef.current === roomId) {
          setCurrentEpoch(keyEpoch);
          setRotationRequired(false);
        }
        fetchRooms();
      });
      socket.on('device:revoked', () => {
        clearSession();
        window.location.reload();
      });
      fetchRooms();
    }

    connect();
    return () => {
      disposed = true;
      socket?.disconnect();
      socketRef.current = null;
    };
  }, [user, decryptAndStore, importStoredKeys, markAsRead]);

  async function fetchRooms() {
    if (!user?.authToken) return;
    try { setRooms(await apiFetch('/rooms')); } catch { setRooms([]); }
  }

  async function joinRoom(roomId) {
    setMessages([]);
    setDecryptedTexts({});
    setActiveRoom(roomId);
    setRotationRequired(false);
    await importStoredKeys(roomId);
    socketRef.current?.emit('room:join', { roomId });
  }

  async function sendMessage(text) {
    const groupKey = roomKeysRef.current.get(currentEpoch);
    if (!text.trim() || !groupKey || !activeRoom || rotationRequired) return;
    const { ciphertext, iv } = await encryptMessage(text.trim(), groupKey);
    const message = {
      id: crypto.randomUUID(), ciphertext, iv, keyEpoch: currentEpoch, timestamp: Date.now(),
    };
    socketRef.current?.emit('message:send', { roomId: activeRoom, message });
    setDecryptedTexts((prev) => ({ ...prev, [message.id]: text.trim() }));
  }

  function startTyping() {
    if (activeRoom) socketRef.current?.emit('typing:start', { roomId: activeRoom });
  }
  function stopTyping() {
    if (activeRoom) socketRef.current?.emit('typing:stop', { roomId: activeRoom });
  }

  return {
    rooms, activeRoom, messages, members, onlineInRoom, globalOnline, typingUsers,
    decryptedTexts, rotationRequired, joinRoom, sendMessage, startTyping, stopTyping,
    refreshRooms: fetchRooms,
    setGroupKey: (key, epoch = 1) => {
      roomKeysRef.current = new Map([[epoch, key]]);
      setCurrentEpoch(epoch);
    },
  };
}

export async function registerUser(username, deviceName = 'Pierwsze urządzenie') {
  const keyPair = await generateKeyPair();
  const publicKey = await exportPublicKey(keyPair.publicKey);
  const authToken = generateAuthToken();
  const result = await apiFetch('/users', {
    method: 'POST',
    body: JSON.stringify({ username, publicKey, authToken, deviceName }),
  }, null);
  await saveKeys(keyPair);
  saveSession(result.id, result.username, result.deviceId, authToken, deviceName);
  return {
    id: result.id, userId: result.id, username: result.username,
    publicKey, deviceId: result.deviceId, authToken, deviceName,
  };
}

export async function createRoom(name, members, groupKeyBase64) {
  const encryptedDeviceKeys = {};
  const memberIds = [];
  for (const member of members) {
    memberIds.push(member.id);
    for (const device of member.devices || []) {
      encryptedDeviceKeys[device.id] = await encryptGroupKeyForUser(groupKeyBase64, device.publicKey);
    }
  }
  return apiFetch('/rooms', {
    method: 'POST', body: JSON.stringify({ name, memberIds, encryptedDeviceKeys }),
  });
}
