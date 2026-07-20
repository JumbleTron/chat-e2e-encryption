const DB_NAME = 'message_app_mls';
const DB_VERSION = 1;
const VALUE_STORE = 'values';
const KEY_STORE = 'keys';
const STORAGE_KEY_ID = 'device-storage-key';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(VALUE_STORE)) {
        const store = db.createObjectStore(VALUE_STORE, { keyPath: ['namespace', 'key'] });
        store.createIndex('namespace', 'namespace', { unique: false });
      }
      if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export class EncryptedMlsStorage {
  constructor() {
    this.database = openDatabase();
    this.storageKey = this.loadStorageKey();
  }

  async loadStorageKey() {
    const db = await this.database;
    const existing = await requestResult(db.transaction(KEY_STORE).objectStore(KEY_STORE).get(STORAGE_KEY_ID));
    if (existing) return existing;

    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const transaction = db.transaction(KEY_STORE, 'readwrite');
    transaction.objectStore(KEY_STORE).put(key, STORAGE_KEY_ID);
    await transactionDone(transaction);
    return key;
  }

  async get(namespace, key) {
    const db = await this.database;
    const row = await requestResult(
      db.transaction(VALUE_STORE).objectStore(VALUE_STORE).get([namespace, key])
    );
    if (!row) return null;
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: row.iv }, await this.storageKey, row.ciphertext
    );
    return new Uint8Array(plaintext);
  }

  async put(namespace, key, value) {
    const db = await this.database;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, await this.storageKey, new Uint8Array(value)
    );
    const transaction = db.transaction(VALUE_STORE, 'readwrite');
    transaction.objectStore(VALUE_STORE).put({
      namespace, key, iv, ciphertext: new Uint8Array(ciphertext),
    });
    await transactionDone(transaction);
  }

  async del(namespace, key) {
    const db = await this.database;
    const transaction = db.transaction(VALUE_STORE, 'readwrite');
    transaction.objectStore(VALUE_STORE).delete([namespace, key]);
    await transactionDone(transaction);
  }

  async listKeys(namespace, prefix = '') {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const keys = [];
      const request = db.transaction(VALUE_STORE)
        .objectStore(VALUE_STORE).index('namespace').openCursor(IDBKeyRange.only(namespace));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve(keys);
        if (cursor.value.key.startsWith(prefix)) keys.push(cursor.value.key);
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }
}

export function deleteMlsStorage() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
    request.onblocked = resolve;
  });
}
