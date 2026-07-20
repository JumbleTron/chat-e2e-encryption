import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { Decoder } from 'cbor-x';
import {
  activateDevice,
  addMlsKeyPackages,
  addMlsMessageRead,
  addMlsRoomMembers,
  acknowledgeMlsWelcome,
  closeDatabase,
  createDevice,
  createLinkRequest,
  createMlsRoom,
  createUser,
  findDeviceByTokenHash,
  findLinkRequest,
  findMlsDeviceByServerDevice,
  finalizeMlsPendingMembers,
  findMlsRoomByConversation,
  findMlsRoomById,
  findServerUsersForMlsDevices,
  findUserById,
  findUserByUsername,
  getDbDescription,
  getMlsMessageReads,
  getMlsLinkApprover,
  getMlsProfile,
  getMlsPendingMemberIds,
  getRecoveryBackup,
  getRoomMemberIds,
  getRoomMembers,
  getUserRoomIds,
  initDatabase,
  insertMlsEnvelope,
  listPendingLinkRequests,
  listMlsEnvelopes,
  listPendingMlsWelcomes,
  listRooms,
  listUserDevices,
  listUsers,
  pingDatabase,
  claimMlsDevices,
  claimMlsDevice,
  registerMlsProfile,
  revokeDevice,
  saveRecoveryBackup,
  saveMlsLinkSecret,
  touchDevice,
} from './db.js';

const app = express();
const httpServer = createServer(app);
const allowedOrigin = process.env.CLIENT_ORIGIN || '*';
const io = new Server(httpServer, {
  cors: { origin: allowedOrigin, methods: ['GET', 'POST', 'DELETE'] },
});
const cborDecoder = new Decoder({ mapsAsObjects: false });

app.use(cors({ origin: allowedOrigin }));
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '2mb' }));

const onlineUsers = new Map(); // socketId -> userId
const userSockets = new Map(); // deviceId -> socketId

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function parseBase64(value, label, maxLength = 1024 * 1024) {
  if (typeof value !== 'string' || !value.length) throw new Error(`${label} is required`);
  const buffer = Buffer.from(value, 'base64');
  if (!buffer.length || buffer.length > maxLength || buffer.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
    throw new Error(`${label} is invalid`);
  }
  return buffer;
}

function serializeMlsEnvelope(row) {
  return {
    version: Number(row.version),
    conversationId: Buffer.from(row.conversationId).toString('base64'),
    epoch: Number(row.epoch),
    kind: row.kind,
    senderDeviceId: Buffer.from(row.senderMlsDeviceId).toString('base64'),
    sequence: Number(row.sequenceNumber),
    wallTime: Number(row.wallTime),
    logicalTime: Number(row.logicalTime),
    payload: Buffer.from(row.payload).toString('base64'),
    contentHash: Buffer.from(row.contentHash).toString('base64'),
  };
}

function parseMlsCursor(value) {
  if (!value) return { epoch: 0, lastSequencePerDevice: new Map() };
  const bytes = parseBase64(value, 'cursor', 4096);
  const decoded = cborDecoder.decode(bytes);
  if (!(decoded instanceof Map)) throw new Error('cursor is invalid');
  const epoch = Number(decoded.get('epoch'));
  const sequences = decoded.get('last_seq_per_device');
  if (!Number.isSafeInteger(epoch) || epoch < 0 || !(sequences instanceof Map) || sequences.size > 1024) {
    throw new Error('cursor is invalid');
  }
  const lastSequencePerDevice = new Map();
  for (const [deviceId, sequence] of sequences) {
    const id = Buffer.from(deviceId);
    const number = Number(sequence);
    if (!id.length || id.length > 64 || !Number.isSafeInteger(number) || number < 0) {
      throw new Error('cursor is invalid');
    }
    lastSequencePerDevice.set(id.toString('hex'), { deviceId: id, sequence: number });
  }
  return { epoch, lastSequencePerDevice };
}

async function findAuthenticatedDevice(token) {
  if (!token) return null;
  const device = await findDeviceByTokenHash(hashToken(token));
  return device?.status === 'active' ? device : null;
}

async function requireAuth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const device = await findAuthenticatedDevice(token);
    if (!device) return res.status(401).json({ error: 'Unauthorized device' });
    req.device = device;
    await touchDevice(device.id);
    next();
  } catch (error) {
    next(error);
  }
}

function route(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

app.get('/api/health', route(async (_req, res) => {
  await pingDatabase();
  res.json({ status: 'ok', database: 'mysql' });
}));

app.post('/api/users', route(async (req, res) => {
  const { username, publicKey, authToken, deviceName = 'To urządzenie' } = req.body;
  if (!username?.trim() || !publicKey || !authToken) {
    return res.status(400).json({ error: 'username, publicKey and authToken required' });
  }
  if (username.trim().length > 32 || String(deviceName).trim().length > 64) {
    return res.status(400).json({ error: 'Username or device name is too long' });
  }
  if (await findUserByUsername(username)) return res.status(409).json({ error: 'Username already taken' });
  const user = await createUser(uuidv4(), username, publicKey);
  const device = await createDevice({
    id: uuidv4(), userId: user.id, name: deviceName,
    publicKey, authTokenHash: hashToken(authToken),
  });
  res.json({ ...user, deviceId: device.id });
}));

app.post('/api/device-links', route(async (req, res) => {
  const { username, publicKey, authToken, deviceName = 'Nowe urządzenie' } = req.body;
  if (String(deviceName).trim().length > 64) return res.status(400).json({ error: 'Device name is too long' });
  const user = username?.trim() ? await findUserByUsername(username) : null;
  if (!user || !publicKey || !authToken) return res.status(400).json({ error: 'Invalid link request' });
  const device = await createDevice({
    id: uuidv4(), userId: user.id, name: deviceName, publicKey,
    authTokenHash: hashToken(authToken), status: 'pending',
  });
  const requestId = uuidv4();
  const verificationCode = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = Date.now() + 10 * 60_000;
  await createLinkRequest({ id: requestId, userId: user.id, deviceId: device.id, verificationCode, expiresAt });
  io.to(`user:${user.id}`).emit('device:link-request');
  res.json({ requestId, verificationCode, expiresAt });
}));

app.get('/api/device-links/:id/status', route(async (req, res) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const [device, request] = await Promise.all([
    findDeviceByTokenHash(hashToken(token || '')), findLinkRequest(req.params.id),
  ]);
  if (!device || !request || request.deviceId !== device.id) {
    return res.status(401).json({ error: 'Invalid link request' });
  }
  if (request.expiresAt < Date.now()) return res.status(410).json({ error: 'Link request expired' });
  if (device.status === 'active') {
    const user = await findUserById(device.userId);
    return res.json({ status: 'approved', user: {
      id: user.id, username: user.username, deviceId: device.id, publicKey: device.publicKey,
    }, encryptedMlsIdentity: request.encryptedMlsIdentity });
  }
  res.json({ status: 'pending' });
}));

app.get('/api/device-links', requireAuth, route(async (req, res) => {
  res.json(await listPendingLinkRequests(req.device.userId));
}));

app.post('/api/device-links/:id/approve', requireAuth, route(async (req, res) => {
  const request = await findLinkRequest(req.params.id);
  const { encryptedMlsIdentity } = req.body;
  if (!request || request.userId !== req.device.userId || request.expiresAt < Date.now()) {
    return res.status(404).json({ error: 'Link request not found or expired' });
  }
  if (!encryptedMlsIdentity || encryptedMlsIdentity.length > 16_384) {
    return res.status(400).json({ error: 'Encrypted MLS identity is required' });
  }
  await saveMlsLinkSecret(request.id, encryptedMlsIdentity, req.device.id);
  await activateDevice(request.deviceId);
  io.to(`device:${request.deviceId}`).emit('device:link-approved');
  res.json({ ok: true });
}));

app.get('/api/devices', requireAuth, route(async (req, res) => {
  const devices = await listUserDevices(req.device.userId, true);
  const profiles = await Promise.all(devices.map((device) => findMlsDeviceByServerDevice(device.id)));
  res.json(devices.map((device, index) => ({
    ...device,
    mlsDeviceId: profiles[index]?.mlsDeviceId
      ? Buffer.from(profiles[index].mlsDeviceId).toString('base64') : null,
  })));
}));

app.post('/api/recovery-backup', requireAuth, route(async (req, res) => {
  const { ciphertext, iv, recoveryAuthToken } = req.body;
  if (!ciphertext || !iv || !recoveryAuthToken) {
    return res.status(400).json({ error: 'Incomplete recovery backup' });
  }
  await saveRecoveryBackup(req.device.userId, ciphertext, iv, hashToken(recoveryAuthToken));
  res.json({ ok: true });
}));

app.get('/api/recovery-backup/:username', route(async (req, res) => {
  const user = await findUserByUsername(req.params.username);
  const backup = user && await getRecoveryBackup(user.id);
  if (!backup) return res.status(404).json({ error: 'Recovery backup not found' });
  res.json({ ciphertext: backup.ciphertext, iv: backup.iv, updatedAt: backup.updatedAt });
}));

app.post('/api/recovery-restore', route(async (req, res) => {
  const {
    username, recoveryAuthToken, publicKey, authToken, deviceName = 'Odzyskane urządzenie',
  } = req.body;
  const user = username?.trim() ? await findUserByUsername(username) : null;
  if (String(deviceName).trim().length > 64) return res.status(400).json({ error: 'Device name is too long' });
  const backup = user && await getRecoveryBackup(user.id);
  if (!backup || backup.recoveryAuthHash !== hashToken(recoveryAuthToken || '')) {
    return res.status(401).json({ error: 'Invalid recovery data' });
  }
  if (!publicKey || !authToken) return res.status(400).json({ error: 'Incomplete device data' });
  const device = await createDevice({
    id: uuidv4(), userId: user.id, name: deviceName, publicKey,
    authTokenHash: hashToken(authToken),
  });
  res.json({ id: user.id, username: user.username, deviceId: device.id });
}));

app.delete('/api/devices/:deviceId', requireAuth, route(async (req, res) => {
  if (req.params.deviceId === req.device.id) {
    return res.status(400).json({ error: 'Current device cannot revoke itself' });
  }
  try {
    const roomIds = await revokeDevice(req.params.deviceId, req.device.userId);
    if (!roomIds.length) return res.status(404).json({ error: 'Active device not found' });
    io.to(`device:${req.params.deviceId}`).emit('device:revoked');
    res.json({ roomIds });
  } catch (error) {
    res.status(400).json({ error: error.message === 'LAST_DEVICE' ? 'Cannot revoke last device' : 'Revoke failed' });
  }
}));

app.get('/api/users/:userId/public-key', requireAuth, route(async (req, res) => {
  const user = await findUserById(req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ publicKey: user.publicKey });
}));

app.get('/api/users', requireAuth, route(async (_req, res) => {
  const users = await listUsers();
  res.json(users.map((user) => ({
    ...user,
    mlsUserId: user.mlsUserId ? Buffer.from(user.mlsUserId).toString('base64') : null,
    devices: user.devices.map((device) => ({
      ...device,
      mlsDeviceId: device.mlsDeviceId ? Buffer.from(device.mlsDeviceId).toString('base64') : null,
    })),
  })));
}));

app.post('/api/mls/devices/register', requireAuth, route(async (req, res) => {
  const mlsUserId = parseBase64(req.body.mlsUserId, 'mlsUserId', 64);
  const mlsDeviceId = parseBase64(req.body.mlsDeviceId, 'mlsDeviceId', 64);
  const keyPackages = (req.body.keyPackages || []).map((value) => parseBase64(value, 'keyPackage', 64 * 1024));
  const lastResortKeyPackage = req.body.lastResortKeyPackage
    ? parseBase64(req.body.lastResortKeyPackage, 'lastResortKeyPackage', 64 * 1024)
    : null;
  if (keyPackages.length > 32) return res.status(400).json({ error: 'Too many KeyPackages' });
  try {
    await registerMlsProfile({
      userId: req.device.userId, deviceId: req.device.id, mlsUserId, mlsDeviceId,
    });
  } catch (error) {
    if (error.message === 'MLS_USER_ID_MISMATCH' || error.message === 'MLS_DEVICE_ID_MISMATCH') {
      return res.status(409).json({ error: 'MLS identity does not match the registered account or device' });
    }
    throw error;
  }
  await addMlsKeyPackages(req.device.id, keyPackages, lastResortKeyPackage);
  if (keyPackages.length || lastResortKeyPackage) {
    const link = await getMlsLinkApprover(req.device.id);
    io.to(link ? `device:${link.approvingDeviceId}` : `user:${req.device.userId}`)
      .emit('mls:device-ready', { deviceId: req.device.id });
  }
  const profile = await getMlsProfile(req.device.id);
  res.status(201).json({ ok: true, availablePackages: Number(profile.availablePackages) });
}));

app.post('/api/mls/users/:mlsUserId/devices', requireAuth, route(async (req, res) => {
  if (!/^[a-f0-9]{2,128}$/i.test(req.params.mlsUserId) || req.params.mlsUserId.length % 2) {
    return res.status(400).json({ error: 'Invalid MLS user id' });
  }
  const devices = await claimMlsDevices(Buffer.from(req.params.mlsUserId, 'hex'));
  res.json(devices.map((device) => ({
    deviceId: Buffer.from(device.mlsDeviceId).toString('base64'),
    keyPackage: Buffer.from(device.keyPackage).toString('base64'),
  })));
}));

app.post('/api/mls/devices/:deviceId/key-package', requireAuth, route(async (req, res) => {
  const device = await claimMlsDevice(req.params.deviceId, req.device.userId);
  if (!device) return res.status(404).json({ error: 'MLS device or KeyPackage not found' });
  res.json({
    deviceId: Buffer.from(device.mlsDeviceId).toString('base64'),
    keyPackage: Buffer.from(device.keyPackage).toString('base64'),
  });
}));

app.post('/api/mls/envelopes', requireAuth, route(async (req, res) => {
  const source = req.body.envelope || {};
  if (!['Application', 'Commit', 'Welcome', 'Proposal', 'KeyPackage'].includes(source.kind)) {
    return res.status(400).json({ error: 'Invalid MLS envelope kind' });
  }
  const envelope = {
    version: Number(source.version),
    conversationId: parseBase64(source.conversationId, 'conversationId', 64),
    epoch: Number(source.epoch),
    kind: source.kind,
    senderMlsDeviceId: parseBase64(source.senderDeviceId, 'senderDeviceId', 64),
    sequence: Number(source.sequence),
    wallTime: Number(source.wallTime),
    logicalTime: Number(source.logicalTime),
    payload: parseBase64(source.payload, 'payload', 2 * 1024 * 1024),
    contentHash: parseBase64(source.contentHash, 'contentHash', 64),
  };
  if (![envelope.version, envelope.epoch, envelope.sequence, envelope.wallTime, envelope.logicalTime]
    .every(Number.isSafeInteger)) {
    return res.status(400).json({ error: 'Invalid MLS envelope metadata' });
  }
  const [room, profile] = await Promise.all([
    findMlsRoomByConversation(envelope.conversationId),
    findMlsDeviceByServerDevice(req.device.id),
  ]);
  if (!room || !(await getRoomMemberIds(room.id)).includes(req.device.userId)) {
    return res.status(403).json({ error: 'Not a room member' });
  }
  if (!profile || !Buffer.from(profile.mlsDeviceId).equals(envelope.senderMlsDeviceId)) {
    return res.status(403).json({ error: 'MLS sender does not match authenticated device' });
  }

  const recipients = [...new Set(req.body.recipients || [])]
    .map((value) => parseBase64(value, 'recipient', 64));
  if (source.kind !== 'Welcome' && recipients.length) {
    return res.status(400).json({ error: 'Only Welcome envelopes may have recipients' });
  }
  let recipientUsers = [];
  if (recipients.length) {
    const memberIds = new Set(await getRoomMemberIds(room.id));
    const pendingMemberIds = new Set(await getMlsPendingMemberIds(room.id));
    recipientUsers = await findServerUsersForMlsDevices(recipients);
    if (recipientUsers.length !== recipients.length || recipientUsers.some((item) =>
      !memberIds.has(item.userId) && !pendingMemberIds.has(item.userId))) {
      return res.status(400).json({ error: 'Welcome recipient is not an active room member' });
    }
  }

  const envelopeId = await insertMlsEnvelope(envelope, recipients);
  if (!envelopeId) return res.status(409).json({ error: 'EpochOccupied' });
  if (source.kind === 'Welcome') {
    await finalizeMlsPendingMembers(room.id, recipientUsers.map((recipient) => recipient.userId));
    io.to(`room:${room.id}`).emit('room:members-updated', {
      roomId: room.id, members: await getRoomMembers(room.id),
    });
  }
  const serialized = serializeMlsEnvelope({
    ...envelope,
    senderMlsDeviceId: envelope.senderMlsDeviceId,
    sequenceNumber: envelope.sequence,
  });
  for (const userId of await getRoomMemberIds(room.id)) {
    io.to(`user:${userId}`).emit('mls:envelope', serialized);
  }
  if (source.kind === 'Welcome') {
    for (const recipient of recipientUsers) {
      io.to(`user:${recipient.userId}`).emit('room:invited', { roomId: room.id });
    }
  }
  res.status(201).json({ id: envelopeId });
}));

app.get('/api/mls/conversations/:conversationId/envelopes', requireAuth, route(async (req, res) => {
  if (!/^[a-f0-9]{2,128}$/i.test(req.params.conversationId) || req.params.conversationId.length % 2) {
    return res.status(400).json({ error: 'Invalid conversation id' });
  }
  const conversationId = Buffer.from(req.params.conversationId, 'hex');
  const room = await findMlsRoomByConversation(conversationId);
  if (!room) return res.json([]);
  if (!(await getRoomMemberIds(room.id)).includes(req.device.userId)) {
    return res.status(403).json({ error: 'Not a room member' });
  }
  let cursor;
  try {
    cursor = parseMlsCursor(req.query.cursor);
  } catch {
    return res.status(400).json({ error: 'Invalid MLS sync cursor' });
  }
  res.json((await listMlsEnvelopes(conversationId, cursor, req.query.limit)).map(serializeMlsEnvelope));
}));

app.get('/api/mls/welcomes', requireAuth, route(async (req, res) => {
  const welcomes = await listPendingMlsWelcomes(req.device.id);
  res.json(welcomes.map((row) => ({ id: Number(row.id), envelope: serializeMlsEnvelope(row) })));
}));

app.post('/api/mls/welcomes/:id/ack', requireAuth, route(async (req, res) => {
  if (!await acknowledgeMlsWelcome(req.params.id, req.device.id)) {
    return res.status(404).json({ error: 'Welcome not found' });
  }
  res.json({ ok: true });
}));

app.get('/api/rooms', requireAuth, route(async (req, res) => {
  const memberRooms = new Set(await getUserRoomIds(req.device.userId));
  res.json((await listRooms()).filter((room) => memberRooms.has(room.id) && room.conversationId)
    .map((room) => ({
      ...room,
      conversationId: Buffer.from(room.conversationId).toString('base64'),
      rotationRequired: false,
    })));
}));

app.post('/api/rooms', requireAuth, route(async (req, res) => {
  const { name, memberIds = [], conversationId: encodedConversationId } = req.body;
  const creatorId = req.device.userId;
  if (!name?.trim() || !encodedConversationId) return res.status(400).json({ error: 'name and conversationId required' });
  if (name.trim().length > 64) return res.status(400).json({ error: 'Room name is too long' });
  if (!await findUserById(creatorId)) return res.status(404).json({ error: 'Creator not found' });
  const uniqueMemberIds = [...new Set([creatorId, ...memberIds])];
  const users = await Promise.all(uniqueMemberIds.map((id) => findUserById(id)));
  if (users.some((user) => !user)) return res.status(400).json({ error: 'Unknown room member' });
  const profiles = await Promise.all(uniqueMemberIds.map(async (id) => {
    const devices = await listUserDevices(id);
    return devices.some((device) => device.status === 'active');
  }));
  if (profiles.some((available) => !available)) {
    return res.status(400).json({ error: 'Every room member must have an active device' });
  }
  const conversationId = parseBase64(encodedConversationId, 'conversationId', 64);
  const room = await createMlsRoom(
    uuidv4(), name, creatorId, req.device.id, uniqueMemberIds, conversationId
  );
  res.json({ id: room.id, name: room.name, conversationId: encodedConversationId });
}));

app.get('/api/rooms/:roomId', requireAuth, route(async (req, res) => {
  const room = await findMlsRoomById(req.params.roomId);
  if (!room || !(await getRoomMemberIds(room.id)).includes(req.device.userId)) {
    return res.status(404).json({ error: 'Room not found' });
  }
  res.json({ ...room, conversationId: Buffer.from(room.conversationId).toString('base64') });
}));

app.get('/api/rooms/:roomId/members', requireAuth, route(async (req, res) => {
  if (!(await getRoomMemberIds(req.params.roomId)).includes(req.device.userId)) {
    return res.status(403).json({ error: 'Not a room member' });
  }
  res.json(await getRoomMembers(req.params.roomId));
}));

app.post('/api/rooms/:roomId/members', requireAuth, route(async (req, res) => {
  const roomId = req.params.roomId;
  const room = await findMlsRoomById(roomId);
  if (!room || room.creatorId !== req.device.userId) {
    return res.status(403).json({ error: 'Only the room creator can invite members' });
  }
  const existingMembers = new Set(await getRoomMemberIds(roomId));
  const userIds = [...new Set(req.body.userIds || [])].filter((id) => !existingMembers.has(id));
  if (!userIds.length) return res.status(400).json({ error: 'No new members selected' });
  const invitedUsers = await Promise.all(userIds.map((id) => findUserById(id)));
  if (invitedUsers.some((user) => !user)) return res.status(400).json({ error: 'Unknown user in invitation' });
  await addMlsRoomMembers(roomId, userIds, req.device.id);
  res.status(202).json({ pendingUserIds: userIds });
}));

io.use(async (socket, next) => {
  try {
    const device = await findAuthenticatedDevice(socket.handshake.auth?.token);
    if (!device || device.id !== socket.handshake.auth?.deviceId) return next(new Error('Unauthorized device'));
    socket.device = device;
    next();
  } catch (error) {
    next(error);
  }
});

function onSocket(socket, event, handler) {
  socket.on(event, (...args) => Promise.resolve(handler(...args)).catch((error) => {
    console.error(`Socket event ${event} failed:`, error);
    socket.emit('server:error', { event, message: 'Server operation failed' });
  }));
}

io.on('connection', async (socket) => {
  const { userId, id: deviceId } = socket.device;
  userSockets.set(deviceId, socket.id);
  onlineUsers.set(socket.id, userId);
  socket.userId = userId;
  socket.deviceId = deviceId;
  socket.join(`user:${userId}`);
  socket.join(`device:${deviceId}`);
  touchDevice(deviceId).catch((error) => console.error('Device heartbeat failed:', error));
  io.emit('presence:update', getOnlineUserIds());

  onSocket(socket, 'room:join', async ({ roomId }) => {
    const [room, user, memberIds] = await Promise.all([
      findMlsRoomById(roomId), findUserById(userId), getRoomMemberIds(roomId),
    ]);
    if (!room || !user || !memberIds.includes(userId)) return;
    socket.join(`room:${roomId}`);
    const members = await getRoomMembers(roomId);
    socket.to(`room:${roomId}`).emit('room:member-joined', { userId, username: user.username, members });
    io.to(`room:${roomId}`).emit('room:online', {
      roomId, onlineUserIds: await getRoomOnlineUserIds(roomId),
    });
  });

  onSocket(socket, 'room:leave', async ({ roomId }) => {
    socket.leave(`room:${roomId}`);
    io.to(`room:${roomId}`).emit('room:online', {
      roomId, onlineUserIds: await getRoomOnlineUserIds(roomId),
    });
  });


  onSocket(socket, 'message:read', async ({ roomId, messageId }) => {
    if (!await findMlsRoomById(roomId) || !(await getRoomMemberIds(roomId)).includes(userId)) return;
    await addMlsMessageRead(messageId, roomId, userId, socket.device.username, Date.now());
    io.to(`room:${roomId}`).emit('message:read-update', {
      messageId, readBy: await getMlsMessageReads(messageId),
    });
  });

  onSocket(socket, 'typing:start', async ({ roomId }) => {
    if (!(await getRoomMemberIds(roomId)).includes(userId)) return;
    socket.to(`room:${roomId}`).emit('typing:start', { userId, username: socket.device.username });
  });

  onSocket(socket, 'typing:stop', async ({ roomId }) => {
    if (!(await getRoomMemberIds(roomId)).includes(userId)) return;
    socket.to(`room:${roomId}`).emit('typing:stop', { userId });
  });

  socket.on('disconnect', () => {
    Promise.resolve().then(async () => {
      const disconnectedUserId = onlineUsers.get(socket.id);
      if (!disconnectedUserId) return;
      userSockets.delete(socket.deviceId);
      onlineUsers.delete(socket.id);
      io.emit('presence:update', getOnlineUserIds());
      for (const roomId of await getUserRoomIds(disconnectedUserId)) {
        io.to(`room:${roomId}`).emit('room:online', {
          roomId, onlineUserIds: await getRoomOnlineUserIds(roomId),
        });
      }
    }).catch((error) => console.error('Disconnect cleanup failed:', error));
  });
});

function getOnlineUserIds() {
  return [...new Set(onlineUsers.values())];
}

async function getRoomOnlineUserIds(roomId) {
  const online = getOnlineUserIds();
  return (await getRoomMemberIds(roomId)).filter((id) => online.includes(id));
}

app.use((error, _req, res, _next) => {
  console.error(error);
  const duplicate = error?.code === 'ER_DUP_ENTRY';
  res.status(duplicate ? 409 : 500).json({ error: duplicate ? 'Resource already exists' : 'Internal server error' });
});

await initDatabase();

const PORT = Number(process.env.PORT || 3001);
httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Database: ${getDbDescription()}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down...`);
  const forcedExit = setTimeout(() => process.exit(1), 10_000).unref();
  await new Promise((resolve) => io.close(resolve));
  await closeDatabase();
  clearTimeout(forcedExit);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
