import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:3001';

function b64(bytes = randomBytes(32)) {
  return Buffer.from(bytes).toString('base64');
}

async function api(path, options = {}, token = null) {
  const headers = new Headers(options.headers || {});
  if (options.body) headers.set('content-type', 'application/json');
  if (token) headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(`${origin}/api${path}`, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status}: ${data.error || 'request failed'}`);
  return data;
}

async function register(username) {
  const authToken = b64();
  const user = await api('/users', {
    method: 'POST',
    body: JSON.stringify({ username, publicKey: b64(), authToken, deviceName: 'Integration test' }),
  });
  const mlsUserId = randomBytes(32);
  const mlsDeviceId = randomBytes(32);
  await api('/mls/devices/register', {
    method: 'POST',
    body: JSON.stringify({
      mlsUserId: b64(mlsUserId),
      mlsDeviceId: b64(mlsDeviceId),
      keyPackages: [b64(randomBytes(128))],
      lastResortKeyPackage: b64(randomBytes(128)),
    }),
  }, authToken);
  return { ...user, authToken, mlsUserId, mlsDeviceId };
}

const suffix = Date.now().toString(36);
const alice = await register(`api_alice_${suffix}`);
const bob = await register(`api_bob_${suffix}`);
const conversationId = randomBytes(16);
const room = await api('/rooms', {
  method: 'POST',
  body: JSON.stringify({
    name: `API MLS ${suffix}`,
    memberIds: [bob.id],
    conversationId: b64(conversationId),
  }),
}, alice.authToken);

const claimed = await api(`/mls/users/${alice.mlsUserId.toString('hex')}/devices`, {
  method: 'POST',
}, bob.authToken);
assert.equal(claimed.length, 1);

function envelope(kind, overrides = {}) {
  return {
    version: 2,
    conversationId: b64(conversationId),
    epoch: 1,
    kind,
    senderDeviceId: b64(alice.mlsDeviceId),
    sequence: overrides.sequence || 1,
    wallTime: Date.now(),
    logicalTime: 0,
    payload: b64(randomBytes(96)),
    contentHash: b64(randomBytes(32)),
    ...overrides,
  };
}

const welcome = await api('/mls/envelopes', {
  method: 'POST',
  body: JSON.stringify({
    envelope: envelope('Welcome'), recipients: [b64(bob.mlsDeviceId)],
  }),
}, alice.authToken);
const pending = await api('/mls/welcomes', {}, bob.authToken);
assert.equal(pending.some((item) => item.id === welcome.id), true);
await api(`/mls/welcomes/${welcome.id}/ack`, { method: 'POST' }, bob.authToken);

await api('/mls/envelopes', {
  method: 'POST', body: JSON.stringify({ envelope: envelope('Application', { sequence: 2 }) }),
}, alice.authToken);
const history = await api(
  `/mls/conversations/${conversationId.toString('hex')}/envelopes?limit=100`, {}, bob.authToken
);
assert.equal(history.length >= 2, true);
assert.equal(history.some((item) => item.kind === 'Application'), true);
assert.equal((await api('/rooms', {}, bob.authToken)).some((item) => item.id === room.id), true);

let spoofRejected = false;
try {
  await api('/mls/envelopes', {
    method: 'POST',
    body: JSON.stringify({ envelope: envelope('Application', {
      sequence: 3, senderDeviceId: b64(bob.mlsDeviceId),
    }) }),
  }, alice.authToken);
} catch (error) {
  spoofRejected = error.message.startsWith('403:');
}
assert.equal(spoofRejected, true);

console.log('Integration test passed: MySQL MLS Delivery Service, Welcome routing and sender binding.');
