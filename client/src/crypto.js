const STORAGE_KEYS = {
  userId: 'e2e_chat_userId',
  username: 'e2e_chat_username',
  privateKey: 'e2e_chat_privateKey',
  publicKey: 'e2e_chat_publicKey',
  groupKeys: 'e2e_chat_groupKeys',
  deviceId: 'e2e_chat_deviceId',
  deviceName: 'e2e_chat_deviceName',
  authToken: 'e2e_chat_authToken',
};

const KEY_DB_NAME = 'e2e_chat_secure_keys';
const KEY_STORE_NAME = 'crypto_keys';

function openKeyDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(KEY_DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(KEY_STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeCryptoKey(id, key) {
  const db = await openKeyDatabase();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(KEY_STORE_NAME, 'readwrite');
    transaction.objectStore(KEY_STORE_NAME).put(key, id);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

async function readCryptoKey(id) {
  const db = await openKeyDatabase();
  const value = await new Promise((resolve, reject) => {
    const request = db.transaction(KEY_STORE_NAME).objectStore(KEY_STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return value;
}

async function deleteStoredKeys() {
  const db = await openKeyDatabase();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(KEY_STORE_NAME, 'readwrite');
    transaction.objectStore(KEY_STORE_NAME).clear();
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export async function generateKeyPair() {
  return crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function exportPublicKey(key) {
  const exported = await crypto.subtle.exportKey('spki', key);
  return arrayBufferToBase64(exported);
}

export async function importPublicKey(base64) {
  return crypto.subtle.importKey(
    'spki',
    base64ToArrayBuffer(base64),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    true,
    ['encrypt']
  );
}

export async function importPrivateKey(base64) {
  return crypto.subtle.importKey(
    'pkcs8',
    base64ToArrayBuffer(base64),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['decrypt']
  );
}

export async function generateGroupKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function exportGroupKey(key) {
  const exported = await crypto.subtle.exportKey('raw', key);
  return arrayBufferToBase64(exported);
}

export async function importGroupKey(base64) {
  return crypto.subtle.importKey(
    'raw',
    base64ToArrayBuffer(base64),
    { name: 'AES-GCM' },
    true,
    ['encrypt', 'decrypt']
  );
}

export async function encryptGroupKeyForUser(groupKeyBase64, recipientPublicKeyBase64) {
  const publicKey = await importPublicKey(recipientPublicKeyBase64);
  const rawKey = base64ToArrayBuffer(groupKeyBase64);
  const encrypted = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, rawKey);
  return arrayBufferToBase64(encrypted);
}

export async function decryptGroupKey(encryptedBase64, privateKey) {
  const decrypted = await crypto.subtle.decrypt(
    { name: 'RSA-OAEP' },
    privateKey,
    base64ToArrayBuffer(encryptedBase64)
  );
  return arrayBufferToBase64(decrypted);
}

export async function encryptMessage(plaintext, groupKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, groupKey, encoded);
  return {
    ciphertext: arrayBufferToBase64(ciphertext),
    iv: arrayBufferToBase64(iv),
  };
}

export async function decryptMessage(ciphertextBase64, ivBase64, groupKey) {
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToArrayBuffer(ivBase64) },
    groupKey,
    base64ToArrayBuffer(ciphertextBase64)
  );
  return new TextDecoder().decode(decrypted);
}

export function generateAuthToken() {
  return arrayBufferToBase64(crypto.getRandomValues(new Uint8Array(32)));
}

export function saveSession(userId, username, deviceId, authToken, deviceName = 'To urządzenie') {
  localStorage.setItem(STORAGE_KEYS.userId, userId);
  localStorage.setItem(STORAGE_KEYS.username, username);
  localStorage.setItem(STORAGE_KEYS.deviceId, deviceId);
  localStorage.setItem(STORAGE_KEYS.authToken, authToken);
  localStorage.setItem(STORAGE_KEYS.deviceName, deviceName);
}

export async function saveKeys(keyPair) {
  const publicKey = await exportPublicKey(keyPair.publicKey);
  await storeCryptoKey('privateKey', keyPair.privateKey);
  localStorage.setItem(STORAGE_KEYS.publicKey, publicKey);
  localStorage.removeItem(STORAGE_KEYS.privateKey);
  return publicKey;
}

export function loadSession() {
  const userId = localStorage.getItem(STORAGE_KEYS.userId);
  const username = localStorage.getItem(STORAGE_KEYS.username);
  const publicKey = localStorage.getItem(STORAGE_KEYS.publicKey);
  const privateKey = localStorage.getItem(STORAGE_KEYS.privateKey);
  const deviceId = localStorage.getItem(STORAGE_KEYS.deviceId);
  const deviceName = localStorage.getItem(STORAGE_KEYS.deviceName);
  const authToken = localStorage.getItem(STORAGE_KEYS.authToken);
  if (!userId || !username || !publicKey) return null;
  return {
    id: userId, userId, username, publicKey, privateKey,
    deviceId, deviceName, authToken, legacy: !deviceId || !authToken,
  };
}

export function clearSession() {
  Object.values(STORAGE_KEYS).forEach((k) => localStorage.removeItem(k));
  deleteStoredKeys().catch(() => {});
}

export function saveRoomGroupKey(roomId, groupKeyBase64, keyEpoch = 1) {
  const keys = JSON.parse(localStorage.getItem(STORAGE_KEYS.groupKeys) || '{}');
  const existing = keys[roomId];
  if (typeof existing === 'string') keys[roomId] = { 1: existing };
  if (!keys[roomId]) keys[roomId] = {};
  keys[roomId][keyEpoch] = groupKeyBase64;
  localStorage.setItem(STORAGE_KEYS.groupKeys, JSON.stringify(keys));
}

export function getRoomGroupKeys(roomId) {
  const keys = JSON.parse(localStorage.getItem(STORAGE_KEYS.groupKeys) || '{}');
  const roomKeys = keys[roomId];
  if (!roomKeys) return {};
  return typeof roomKeys === 'string' ? { 1: roomKeys } : roomKeys;
}

export function getRoomGroupKey(roomId, keyEpoch = null) {
  const roomKeys = getRoomGroupKeys(roomId);
  if (keyEpoch !== null) return roomKeys[keyEpoch] || null;
  const epochs = Object.keys(roomKeys).map(Number).sort((a, b) => b - a);
  return epochs.length ? roomKeys[epochs[0]] : null;
}

export async function loadPrivateKey() {
  const stored = await readCryptoKey('privateKey');
  if (stored) return stored;
  const legacyPrivateKey = localStorage.getItem(STORAGE_KEYS.privateKey);
  if (!legacyPrivateKey) return null;
  const imported = await importPrivateKey(legacyPrivateKey);
  await storeCryptoKey('privateKey', imported);
  localStorage.removeItem(STORAGE_KEYS.privateKey);
  return imported;
}

export { STORAGE_KEYS };
