import { apiFetch } from './api';
import {
  decryptFromDevice,
  encryptForDevice,
  exportPublicKey,
  generateAuthToken,
  generateKeyPair,
  loadSession,
  saveKeys,
  saveSession,
} from './crypto';
import { exportMlsIdentity, getMlsRuntime, initializeMls } from './mls/client';
import { base64ToBytes as mlsBase64ToBytes, bytesToBase64 as mlsBytesToBase64 } from './mls/encoding';

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
  if (!result.encryptedMlsIdentity) throw new Error('Brak zaszyfrowanej tożsamości MLS');
  const identityBase64 = await decryptFromDevice(result.encryptedMlsIdentity, link.keyPair.privateKey);
  await saveKeys(link.keyPair);
  saveSession(
    result.user.id, result.user.username, result.user.deviceId,
    link.authToken, link.deviceName
  );
  const session = loadSession();
  await initializeMls(session, mlsBase64ToBytes(identityBase64));
  return session;
}

export function listDevices() {
  return apiFetch('/devices');
}

export function listLinkRequests() {
  return apiFetch('/device-links');
}

export async function approveDeviceLink(request) {
  const identity = await exportMlsIdentity();
  const encryptedMlsIdentity = await encryptForDevice(
    mlsBytesToBase64(identity), request.publicKey
  );
  identity.fill(0);
  await apiFetch(`/device-links/${request.id}/approve`, {
    method: 'POST', body: JSON.stringify({ encryptedMlsIdentity }),
  });
}

export async function revokeDevice(deviceId) {
  const target = (await listDevices()).find((device) => device.id === deviceId);
  if (target?.mlsDeviceId) {
    await getMlsRuntime().client.revokeDevice(mlsBase64ToBytes(target.mlsDeviceId));
  }
  const { roomIds } = await apiFetch(`/devices/${deviceId}`, { method: 'DELETE' });
  return roomIds;
}

export async function repairPendingRotations() {
  return [];
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
  const identity = await exportMlsIdentity();
  const recoveryKeyBytes = crypto.getRandomValues(new Uint8Array(32));
  const recoveryKey = await crypto.subtle.importKey(
    'raw', recoveryKeyBytes, { name: 'AES-GCM' }, false, ['encrypt']
  );
  const recoveryAuthToken = generateAuthToken();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = new TextEncoder().encode(JSON.stringify({
    version: 2, recoveryAuthToken, mlsIdentity: mlsBytesToBase64(identity),
  }));
  identity.fill(0);
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
  if (vault.version !== 2 || !vault.recoveryAuthToken || !vault.mlsIdentity) {
    throw new Error('Nieobsługiwany format kopii zapasowej');
  }

  const keyPair = await generateKeyPair();
  const publicKey = await exportPublicKey(keyPair.publicKey);
  const authToken = generateAuthToken();
  const result = await apiFetch('/recovery-restore', {
    method: 'POST',
    body: JSON.stringify({
      username, recoveryAuthToken: vault.recoveryAuthToken, publicKey,
      authToken, deviceName, encryptedRoomKeys: [],
    }),
  }, null);
  await saveKeys(keyPair);
  saveSession(result.id, result.username, result.deviceId, authToken, deviceName);
  const session = loadSession();
  await initializeMls(session, mlsBase64ToBytes(vault.mlsIdentity));
  return session;
}

export function browserDeviceName() {
  const platform = navigator.userAgentData?.platform || navigator.platform || 'Przeglądarka';
  return `${platform} - przeglądarka`;
}
