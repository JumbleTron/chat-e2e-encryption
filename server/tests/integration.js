import assert from 'node:assert/strict';
import { io } from 'socket.io-client';

const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:3001';
const apiBase = `${origin}/api`;

const toBase64 = (value) => Buffer.from(value).toString('base64');
const fromBase64 = (value) => Buffer.from(value, 'base64');

async function api(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

function waitFor(socket, event, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off(event, onResult);
      socket.off('connect_error', onError);
      socket.off('server:error', onError);
    };
    const onResult = (value) => {
      cleanup();
      resolve(value);
    };
    const onError = (error) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(JSON.stringify(error)));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    socket.once(event, onResult);
    socket.once('connect_error', onError);
    socket.once('server:error', onError);
  });
}

const suffix = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
const authToken = `integration-${suffix}`;
let socket;

try {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt']
  );
  const publicKey = toBase64(await crypto.subtle.exportKey('spki', keyPair.publicKey));
  const user = await api('/users', {
    method: 'POST',
    body: { username: `ci-${suffix}`, publicKey, authToken, deviceName: 'CI device' },
  });

  const groupKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
  );
  const rawGroupKey = await crypto.subtle.exportKey('raw', groupKey);
  const wrappedKey = toBase64(await crypto.subtle.encrypt(
    { name: 'RSA-OAEP' }, keyPair.publicKey, rawGroupKey
  ));
  const room = await api('/rooms', {
    token: authToken,
    method: 'POST',
    body: {
      name: 'Integration room', memberIds: [user.id],
      encryptedDeviceKeys: { [user.deviceId]: wrappedKey },
    },
  });

  socket = io(origin, {
    transports: ['websocket'],
    auth: { deviceId: user.deviceId, token: authToken },
  });
  await waitFor(socket, 'connect');
  const historyPromise = waitFor(socket, 'room:history');
  socket.emit('room:join', { roomId: room.id });
  const history = await historyPromise;
  assert.equal(history.currentEpoch, 1);
  assert.equal(history.encryptedGroupKeys.length, 1);

  const recoveredKey = await crypto.subtle.decrypt(
    { name: 'RSA-OAEP' }, keyPair.privateKey,
    fromBase64(history.encryptedGroupKeys[0].encryptedGroupKey)
  );
  assert.deepEqual(Buffer.from(recoveredKey), Buffer.from(rawGroupKey));

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, groupKey, new TextEncoder().encode('MySQL E2EE integration')
  );
  const messagePromise = waitFor(socket, 'message:new');
  socket.emit('message:send', {
    roomId: room.id,
    message: {
      id: crypto.randomUUID(), ciphertext: toBase64(ciphertext),
      iv: toBase64(iv), keyEpoch: 1, timestamp: Date.now(),
    },
  });
  const message = await messagePromise;
  assert.equal(message.senderId, user.id);
  assert.equal(message.senderDeviceId, user.deviceId);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(message.iv) }, groupKey, fromBase64(message.ciphertext)
  );
  assert.equal(new TextDecoder().decode(plaintext), 'MySQL E2EE integration');
  assert.ok((await api('/rooms', { token: authToken })).some((item) => item.id === room.id));

  console.log('Integration test passed: MySQL, authenticated WebSocket and E2EE message flow.');
} finally {
  socket?.close();
}
