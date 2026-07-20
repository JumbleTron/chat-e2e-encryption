import { apiFetch } from './api';
import {
  decryptGroupKey,
  encryptGroupKeyForUser,
  exportPublicKey,
  generateAuthToken,
  generateGroupKey,
  generateKeyPair,
  getRoomGroupKeys,
  exportGroupKey,
  loadPrivateKey,
  loadSession,
  saveKeys,
  saveRoomGroupKey,
  saveSession,
} from './crypto';

export async function migrateLegacySession(session) {
  if (!session?.legacy) return session;
  const { challengeId, encryptedChallenge } = await apiFetch('/devices/legacy-challenge', {
    method: 'POST', body: JSON.stringify({ userId: session.userId }),
  }, null);
  const privateKey = await loadPrivateKey();
  const proof = await decryptGroupKey(encryptedChallenge, privateKey);
  const authToken = generateAuthToken();
  const deviceName = browserDeviceName();
  const result = await apiFetch('/devices/legacy-complete', {
    method: 'POST',
    body: JSON.stringify({ challengeId, proof, authToken, deviceName }),
  }, null);
  saveSession(result.id, result.username, result.deviceId, authToken, deviceName);
  return loadSession();
}

export async function beginDeviceLink(username, deviceName = browserDeviceName()) {
  const keyPair = await generateKeyPair();
  const publicKey = await exportPublicKey(keyPair.publicKey);
  const authToken = generateAuthToken();
  const request = await apiFetch('/device-links', {
    method: 'POST',
    body: JSON.stringify({ username, deviceName, publicKey, authToken }),
  }, null);
  return { ...request, username, deviceName, keyPair, publicKey, authToken };
}

export async function finishDeviceLink(link) {
  const result = await apiFetch(`/device-links/${link.requestId}/status`, {}, {
    authToken: link.authToken,
  });
  if (result.status !== 'approved') return null;
  await saveKeys(link.keyPair);
  saveSession(
    result.user.id, result.user.username, result.user.deviceId,
    link.authToken, link.deviceName
  );
  return loadSession();
}

export function listDevices() {
  return apiFetch('/devices');
}

export function listLinkRequests() {
  return apiFetch('/device-links');
}

export async function approveDeviceLink(request) {
  const wrappedKeys = await apiFetch('/devices/me/room-keys');
  const privateKey = await loadPrivateKey();
  const encryptedRoomKeys = [];
  for (const item of wrappedKeys) {
    const rawKey = await decryptGroupKey(item.encryptedGroupKey, privateKey);
    saveRoomGroupKey(item.roomId, rawKey, item.keyEpoch);
    encryptedRoomKeys.push({
      roomId: item.roomId,
      keyEpoch: item.keyEpoch,
      encryptedGroupKey: await encryptGroupKeyForUser(rawKey, request.publicKey),
    });
  }
  await apiFetch(`/device-links/${request.id}/approve`, {
    method: 'POST', body: JSON.stringify({ encryptedRoomKeys }),
  });
}

export async function inviteRoomMembers(roomId, users) {
  const roomKeys = getRoomGroupKeys(roomId);
  const epochs = Object.entries(roomKeys);
  if (!epochs.length) throw new Error('Brak lokalnych kluczy tego pokoju');

  const encryptedRoomKeys = [];
  for (const user of users) {
    for (const device of user.devices || []) {
      for (const [keyEpoch, rawKey] of epochs) {
        encryptedRoomKeys.push({
          deviceId: device.id,
          keyEpoch: Number(keyEpoch),
          encryptedGroupKey: await encryptGroupKeyForUser(rawKey, device.publicKey),
        });
      }
    }
  }
  return apiFetch(`/rooms/${roomId}/members`, {
    method: 'POST',
    body: JSON.stringify({ userIds: users.map((user) => user.id), encryptedRoomKeys }),
  });
}

export async function revokeDevice(deviceId) {
  const { roomIds } = await apiFetch(`/devices/${deviceId}`, { method: 'DELETE' });
  await rotateRooms(roomIds);
  return roomIds;
}

async function rotateRooms(roomIds) {
  for (const roomId of roomIds) {
    const devices = await apiFetch(`/rooms/${roomId}/devices`);
    const groupKey = await generateGroupKey();
    const rawKey = await exportGroupKey(groupKey);
    const encryptedDeviceKeys = {};
    for (const device of devices) {
      encryptedDeviceKeys[device.id] = await encryptGroupKeyForUser(rawKey, device.publicKey);
    }
    const { keyEpoch } = await apiFetch(`/rooms/${roomId}/rotate-key`, {
      method: 'POST', body: JSON.stringify({ encryptedDeviceKeys }),
    });
    saveRoomGroupKey(roomId, rawKey, keyEpoch);
  }
}

export async function repairPendingRotations() {
  const rooms = await apiFetch('/rooms');
  const roomIds = rooms.filter((room) => room.rotationRequired).map((room) => room.id);
  await rotateRooms(roomIds);
  return roomIds;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value.trim());
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function createRecoveryBackup() {
  const wrappedKeys = await apiFetch('/devices/me/room-keys');
  const privateKey = await loadPrivateKey();
  const roomKeys = [];
  for (const item of wrappedKeys) {
    const rawKey = await decryptGroupKey(item.encryptedGroupKey, privateKey);
    saveRoomGroupKey(item.roomId, rawKey, item.keyEpoch);
    roomKeys.push({ roomId: item.roomId, keyEpoch: item.keyEpoch, rawKey });
  }

  const recoveryKeyBytes = crypto.getRandomValues(new Uint8Array(32));
  const recoveryKey = await crypto.subtle.importKey(
    'raw', recoveryKeyBytes, { name: 'AES-GCM' }, false, ['encrypt']
  );
  const recoveryAuthToken = generateAuthToken();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = new TextEncoder().encode(JSON.stringify({
    version: 1, recoveryAuthToken, roomKeys,
  }));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, recoveryKey, payload);
  await apiFetch('/recovery-backup', {
    method: 'POST',
    body: JSON.stringify({
      ciphertext: bytesToBase64(ciphertext),
      iv: bytesToBase64(iv),
      recoveryAuthToken,
    }),
  });
  return bytesToBase64(recoveryKeyBytes);
}

export async function restoreFromRecovery(username, recoveryCode, deviceName = browserDeviceName()) {
  const backup = await apiFetch(`/recovery-backup/${encodeURIComponent(username.trim())}`, {}, null);
  let vault;
  try {
    const recoveryKey = await crypto.subtle.importKey(
      'raw', base64ToBytes(recoveryCode), { name: 'AES-GCM' }, false, ['decrypt']
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(backup.iv) },
      recoveryKey,
      base64ToBytes(backup.ciphertext)
    );
    vault = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error('Nieprawidłowy kod odzyskiwania');
  }
  if (vault.version !== 1 || !vault.recoveryAuthToken || !Array.isArray(vault.roomKeys)) {
    throw new Error('Nieobsługiwany format kopii zapasowej');
  }

  const keyPair = await generateKeyPair();
  const publicKey = await exportPublicKey(keyPair.publicKey);
  const authToken = generateAuthToken();
  const encryptedRoomKeys = [];
  for (const item of vault.roomKeys) {
    encryptedRoomKeys.push({
      roomId: item.roomId,
      keyEpoch: item.keyEpoch,
      encryptedGroupKey: await encryptGroupKeyForUser(item.rawKey, publicKey),
    });
  }
  const result = await apiFetch('/recovery-restore', {
    method: 'POST',
    body: JSON.stringify({
      username, recoveryAuthToken: vault.recoveryAuthToken, publicKey,
      authToken, deviceName, encryptedRoomKeys,
    }),
  }, null);
  await saveKeys(keyPair);
  for (const item of vault.roomKeys) saveRoomGroupKey(item.roomId, item.rawKey, item.keyEpoch);
  saveSession(result.id, result.username, result.deviceId, authToken, deviceName);
  return loadSession();
}

export function browserDeviceName() {
  const platform = navigator.userAgentData?.platform || navigator.platform || 'Przeglądarka';
  return `${platform} - przeglądarka`;
}
