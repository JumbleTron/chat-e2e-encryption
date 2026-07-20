import { MessagingClient } from 'ping-openmls-sdk';
import { apiFetch } from '../api';
import { base64ToBytes, bytesToBase64, bytesToHex, deserializeEnvelope } from './encoding';
import { EncryptedMlsStorage } from './storage';
import { MessageAppMlsTransport } from './transport';

const APP_NAMESPACE = 'message-app';
const IDENTITY_KEY = 'identity';
const KEY_PACKAGE_BATCH = 8;
let runtime = null;

export async function initializeMls(session, suppliedIdentity = null) {
  if (runtime?.session.deviceId === session.deviceId) return runtime;
  await closeMls();

  const storage = new EncryptedMlsStorage();
  let identity = suppliedIdentity || await storage.get(APP_NAMESPACE, IDENTITY_KEY);
  if (!identity) {
    identity = await MessagingClient.generateIdentity();
    await storage.put(APP_NAMESPACE, IDENTITY_KEY, identity);
  }

  const transport = new MessageAppMlsTransport(session);
  const client = await MessagingClient.init({
    identityExport: identity,
    deviceLabel: session.deviceName || 'Przeglądarka',
    storage,
    transport,
  });
  runtime = { client, transport, storage, session };
  await registerMlsDevice(runtime);
  return runtime;
}

async function registerMlsDevice(current) {
  const [userId, deviceId] = await Promise.all([
    current.client.userId(), current.client.deviceId(),
  ]);
  const profile = await apiFetch('/mls/devices/register', {
    method: 'POST',
    body: JSON.stringify({
      mlsUserId: bytesToBase64(userId),
      mlsDeviceId: bytesToBase64(deviceId),
      keyPackages: [],
    }),
  }, current.session);
  if (profile.availablePackages >= KEY_PACKAGE_BATCH / 2) return;

  const packages = [];
  for (let index = 0; index < KEY_PACKAGE_BATCH; index += 1) {
    packages.push(bytesToBase64(await current.client.freshKeyPackage()));
  }
  await apiFetch('/mls/devices/register', {
    method: 'POST',
    body: JSON.stringify({
      mlsUserId: bytesToBase64(userId), mlsDeviceId: bytesToBase64(deviceId),
      keyPackages: packages,
      lastResortKeyPackage: bytesToBase64(await current.client.freshLastResortKeyPackage()),
    }),
  }, current.session);
}

export async function receiveWelcomes(current = runtime) {
  if (!current) return [];
  const welcomes = await apiFetch('/mls/welcomes', {}, current.session);
  const joined = [];
  for (const item of welcomes) {
    try {
      const conversation = await current.client.joinConversation(deserializeEnvelope(item.envelope));
      joined.push(bytesToHex(conversation.id));
      await apiFetch(`/mls/welcomes/${item.id}/ack`, { method: 'POST' }, current.session);
    } catch (error) {
      if (!String(error.message).toLowerCase().includes('already')) throw error;
      await apiFetch(`/mls/welcomes/${item.id}/ack`, { method: 'POST' }, current.session);
    }
  }
  return joined;
}

export function getMlsRuntime() {
  if (!runtime) throw new Error('MLS nie został zainicjalizowany');
  return runtime;
}

export async function createMlsRoom(name, users) {
  const current = getMlsRuntime();
  const conversation = await current.client.createConversation({ name });
  const conversationId = bytesToBase64(conversation.id);
  const memberIds = users.map((user) => user.id);
  const room = await apiFetch('/rooms', {
    method: 'POST', body: JSON.stringify({ name, memberIds, conversationId }),
  }, current.session);

  const entries = await claimUserDevices(users, current);
  if (entries.length) {
    current.transport.setWelcomeRecipients(entries.map((entry) => entry.deviceId));
    await conversation.addMembers(entries);
  }
  return room;
}

export async function inviteMlsMembers(roomId, users) {
  const current = getMlsRuntime();
  const room = await apiFetch(`/rooms/${roomId}`, {}, current.session);
  const conversation = current.client.getConversation(base64ToBytes(room.conversationId));
  const entries = await claimUserDevices(users, current);
  if (!entries.length) throw new Error('Zapraszani użytkownicy nie mają dostępnych KeyPackage');

  await apiFetch(`/rooms/${roomId}/members`, {
    method: 'POST', body: JSON.stringify({ userIds: users.map((user) => user.id) }),
  }, current.session);
  current.transport.setWelcomeRecipients(entries.map((entry) => entry.deviceId));
  await conversation.addMembers(entries);
}

async function claimUserDevices(users, current) {
  const ownDeviceId = bytesToHex(await current.client.deviceId());
  const entries = [];
  for (const user of users) {
    if (!user.mlsUserId) continue;
    const discovered = await current.transport.discoverDevices(base64ToBytes(user.mlsUserId));
    for (const device of discovered) {
      if (bytesToHex(device.device_id) === ownDeviceId) continue;
      entries.push({ deviceId: device.device_id, keyPackage: device.key_package });
    }
  }
  return entries;
}

export async function exportMlsIdentity() {
  return getMlsRuntime().client.exportIdentity();
}

export async function admitLinkedDevice(serverDeviceId) {
  const current = getMlsRuntime();
  if (serverDeviceId === current.session.deviceId) return [];
  const target = await apiFetch(`/mls/devices/${serverDeviceId}/key-package`, {
    method: 'POST',
  }, current.session);
  const entry = {
    deviceId: base64ToBytes(target.deviceId),
    keyPackage: base64ToBytes(target.keyPackage),
  };
  const rooms = await apiFetch('/rooms', {}, current.session);
  const outcomes = [];
  for (const room of rooms) {
    try {
      const conversation = current.client.getConversation(base64ToBytes(room.conversationId));
      current.transport.setWelcomeRecipients([entry.deviceId]);
      await conversation.addMembers([entry]);
      outcomes.push({ roomId: room.id, status: 'admitted' });
    } catch (error) {
      outcomes.push({ roomId: room.id, status: 'failed', error: error.message });
    }
  }
  return outcomes;
}

export async function closeMls() {
  if (!runtime) return;
  runtime.transport.close();
  await runtime.client.close();
  runtime = null;
}
