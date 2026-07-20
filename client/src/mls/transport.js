import { io } from 'socket.io-client';
import { apiFetch } from '../api';
import {
  base64ToBytes, bytesToBase64, bytesToHex, deserializeEnvelope, serializeEnvelope,
} from './encoding';

export class MessageAppMlsTransport {
  constructor(session) {
    this.session = session;
    this.handlers = new Set();
    this.nextWelcomeRecipients = [];
    this.socket = io({
      transports: ['websocket'],
      auth: { deviceId: session.deviceId, token: session.authToken },
    });
    this.socket.on('mls:envelope', (value) => {
      const envelope = deserializeEnvelope(value);
      for (const handler of this.handlers) handler(envelope);
    });
  }

  async send(envelope) {
    const recipients = envelope.kind === 'Welcome'
      ? this.nextWelcomeRecipients.map(bytesToBase64)
      : [];
    await apiFetch('/mls/envelopes', {
      method: 'POST',
      body: JSON.stringify({ envelope: serializeEnvelope(envelope), recipients }),
    }, this.session);
    if (envelope.kind === 'Welcome') this.nextWelcomeRecipients = [];
  }

  async fetchSince(conversationId, cursor, limit) {
    const values = await apiFetch(
      `/mls/conversations/${bytesToHex(conversationId)}/envelopes?limit=${Math.min(limit, 500)}`
        + `&cursor=${encodeURIComponent(bytesToBase64(cursor))}`,
      {}, this.session
    );
    return values.map(deserializeEnvelope);
  }

  subscribe(handler) {
    this.handlers.add(handler);
    return { unsubscribe: () => this.handlers.delete(handler) };
  }

  async discoverDevices(userId) {
    const devices = await apiFetch(`/mls/users/${bytesToHex(userId)}/devices`, {
      method: 'POST',
    }, this.session);
    return devices.map((device) => ({
      device_id: base64ToBytes(device.deviceId),
      key_package: base64ToBytes(device.keyPackage),
    }));
  }

  async setNextWelcomeRecipients(_conversationId, deviceIds) {
    this.nextWelcomeRecipients = deviceIds;
  }

  setWelcomeRecipients(deviceIds) {
    this.nextWelcomeRecipients = deviceIds;
  }

  close() {
    this.socket.disconnect();
    this.handlers.clear();
  }
}
