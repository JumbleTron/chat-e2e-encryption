import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { apiFetch } from '../api';
import {
  clearSession, exportPublicKey, generateAuthToken, generateKeyPair, saveKeys, saveSession,
} from '../crypto';
import { base64ToBytes, bytesToHex } from '../mls/encoding';
import {
  admitLinkedDevice, createMlsRoom, getMlsRuntime, initializeMls, receiveWelcomes,
} from '../mls/client';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function useChat(user) {
  const socketRef = useRef(null);
  const roomsRef = useRef([]);
  const activeRoomRef = useRef(null);
  const [rooms, setRooms] = useState([]);
  const [activeRoom, setActiveRoom] = useState(null);
  const [messages, setMessages] = useState([]);
  const [members, setMembers] = useState([]);
  const [onlineInRoom, setOnlineInRoom] = useState([]);
  const [globalOnline, setGlobalOnline] = useState([]);
  const [typingUsers, setTypingUsers] = useState([]);
  const [decryptedTexts, setDecryptedTexts] = useState({});
  const [ready, setReady] = useState(false);
  const [securityError, setSecurityError] = useState('');

  useEffect(() => { activeRoomRef.current = activeRoom; }, [activeRoom]);
  useEffect(() => { roomsRef.current = rooms; }, [rooms]);

  const fetchRooms = useCallback(async () => {
    if (!user?.authToken) return [];
    const nextRooms = await apiFetch('/rooms');
    roomsRef.current = nextRooms;
    setRooms(nextRooms);
    return nextRooms;
  }, [user]);

  const storeLocalMessage = useCallback(async (message, text) => {
    const room = roomsRef.current.find((item) => item.id === message.roomId);
    if (!room) return;
    const namespace = `messages:${bytesToHex(base64ToBytes(room.conversationId))}`;
    await getMlsRuntime().storage.put(namespace, message.id, encoder.encode(JSON.stringify({ message, text })));
  }, []);

  const showMessage = useCallback(async (message, text) => {
    if (activeRoomRef.current === message.roomId) {
      setMessages((current) => current.some((item) => item.id === message.id)
        ? current : [...current, message].sort((a, b) => a.timestamp - b.timestamp));
      setDecryptedTexts((current) => ({ ...current, [message.id]: text }));
      if (message.senderId !== user?.id) {
        socketRef.current?.emit('message:read', { roomId: message.roomId, messageId: message.id });
      }
    }
    await storeLocalMessage(message, text);
  }, [storeLocalMessage, user]);

  useEffect(() => {
    if (!user?.deviceId || !user?.authToken) return;
    let disposed = false;
    let unsubscribeMessage;
    let unsubscribeConversation;
    const socket = io({
      transports: ['websocket'], auth: { deviceId: user.deviceId, token: user.authToken },
    });
    socketRef.current = socket;

    socket.on('presence:update', setGlobalOnline);
    socket.on('connect_error', (error) => {
      if (error.message === 'Unauthorized device') {
        clearSession();
        window.location.reload();
      }
    });
    socket.on('room:online', ({ onlineUserIds }) => setOnlineInRoom(onlineUserIds));
    socket.on('room:members-updated', ({ roomId, members: nextMembers }) => {
      if (activeRoomRef.current === roomId) setMembers(nextMembers);
      fetchRooms().catch(() => {});
    });
    socket.on('room:invited', async () => {
      try {
        await receiveWelcomes();
        await getMlsRuntime().client.syncConversations();
        await fetchRooms();
      } catch (error) {
        setSecurityError(error.message);
      }
    });
    socket.on('mls:device-ready', async ({ deviceId }) => {
      if (deviceId === user.deviceId) return;
      try {
        await admitLinkedDevice(deviceId);
      } catch (error) {
        setSecurityError(`Nie udało się dodać urządzenia do pokojów MLS: ${error.message}`);
      }
    });
    socket.on('message:read-update', ({ messageId, readBy }) => {
      setMessages((current) => current.map((message) =>
        message.id === messageId ? { ...message, readBy } : message));
    });
    socket.on('typing:start', ({ userId, username }) => {
      setTypingUsers((current) => current.some((item) => item.userId === userId)
        ? current : [...current, { userId, username }]);
    });
    socket.on('typing:stop', ({ userId }) => {
      setTypingUsers((current) => current.filter((item) => item.userId !== userId));
    });
    socket.on('device:revoked', () => {
      clearSession();
      window.location.reload();
    });

    async function start() {
      try {
        const current = await initializeMls(user);
        if (disposed) return;
        unsubscribeMessage = current.client.onMessage(async (incoming) => {
          try {
            const payload = JSON.parse(decoder.decode(incoming.plaintext));
            if (payload.version !== 1 || !payload.id || !payload.roomId) return;
            await showMessage({
              id: payload.id,
              roomId: payload.roomId,
              senderId: payload.senderId,
              senderUsername: payload.senderUsername,
              senderDeviceId: bytesToHex(incoming.sender_device),
              timestamp: payload.timestamp,
              keyEpoch: incoming.epoch,
              readBy: payload.senderId === user.id
                ? [{ userId: user.id, username: user.username, readAt: payload.timestamp }]
                : [],
            }, payload.text);
          } catch {
            setSecurityError('Odrzucono nieprawidłową wiadomość aplikacyjną MLS');
          }
        });
        unsubscribeConversation = current.client.onConversationUpdated(() => {
          fetchRooms().catch(() => {});
        });
        await fetchRooms();
        await receiveWelcomes(current);
        await current.client.syncConversations();
        if (!disposed) setReady(true);
      } catch (error) {
        if (!disposed) setSecurityError(`Nie udało się uruchomić MLS: ${error.message}`);
      }
    }
    start();

    return () => {
      disposed = true;
      unsubscribeMessage?.();
      unsubscribeConversation?.();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [user, fetchRooms, showMessage]);

  async function joinRoom(roomId) {
    const room = roomsRef.current.find((item) => item.id === roomId);
    if (!room) return;
    setActiveRoom(roomId);
    activeRoomRef.current = roomId;
    setMessages([]);
    setDecryptedTexts({});
    setMembers(await apiFetch(`/rooms/${roomId}/members`));
    socketRef.current?.emit('room:join', { roomId });

    const namespace = `messages:${bytesToHex(base64ToBytes(room.conversationId))}`;
    const storage = getMlsRuntime().storage;
    const keys = await storage.listKeys(namespace, '');
    const cached = [];
    const texts = {};
    for (const key of keys) {
      const value = await storage.get(namespace, key);
      if (!value) continue;
      const item = JSON.parse(decoder.decode(value));
      cached.push(item.message);
      texts[item.message.id] = item.text;
    }
    cached.sort((a, b) => a.timestamp - b.timestamp);
    setMessages(cached);
    setDecryptedTexts(texts);
    await receiveWelcomes();
    await getMlsRuntime().client.syncConversations();
  }

  async function sendMessage(text) {
    const trimmed = text.trim();
    const room = roomsRef.current.find((item) => item.id === activeRoomRef.current);
    if (!trimmed || !room || !ready) return;
    const timestamp = Date.now();
    const message = {
      id: crypto.randomUUID(), roomId: room.id, senderId: user.id,
      senderUsername: user.username, timestamp,
    };
    const payload = encoder.encode(JSON.stringify({ version: 1, ...message, text: trimmed }));
    const conversation = getMlsRuntime().client.getConversation(base64ToBytes(room.conversationId));
    const envelope = await conversation.send(payload);
    const rendered = {
      ...message,
      senderDeviceId: user.deviceId,
      keyEpoch: envelope.epoch,
      readBy: [{ userId: user.id, username: user.username, readAt: timestamp }],
    };
    await showMessage(rendered, trimmed);
  }

  function startTyping() {
    if (activeRoomRef.current) socketRef.current?.emit('typing:start', { roomId: activeRoomRef.current });
  }

  function stopTyping() {
    if (activeRoomRef.current) socketRef.current?.emit('typing:stop', { roomId: activeRoomRef.current });
  }

  return {
    rooms, activeRoom, messages, members, onlineInRoom, globalOnline, typingUsers,
    decryptedTexts, rotationRequired: false, ready, securityError,
    joinRoom, sendMessage, startTyping, stopTyping, refreshRooms: fetchRooms,
  };
}

export async function registerUser(username, deviceName = 'Pierwsze urządzenie') {
  const keyPair = await generateKeyPair();
  const publicKey = await exportPublicKey(keyPair.publicKey);
  const authToken = generateAuthToken();
  const result = await apiFetch('/users', {
    method: 'POST', body: JSON.stringify({ username, publicKey, authToken, deviceName }),
  }, null);
  await saveKeys(keyPair);
  saveSession(result.id, result.username, result.deviceId, authToken, deviceName);
  const session = {
    id: result.id, userId: result.id, username: result.username,
    publicKey, deviceId: result.deviceId, authToken, deviceName,
  };
  await initializeMls(session);
  return session;
}

export function createRoom(name, members) {
  return createMlsRoom(name, members);
}
