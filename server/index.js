import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { createHash, createPublicKey, publicEncrypt, randomBytes } from 'crypto';
import {
  activateDevice,
  addMessageRead,
  copyLegacyRoomKeysToDevice,
  closeDatabase,
  createDevice,
  createLinkRequest,
  createRoom,
  createUser,
  findDeviceById,
  findDeviceByTokenHash,
  findLinkRequest,
  findRoomById,
  findUserById,
  findUserByUsername,
  getAllDeviceRoomKeys,
  getDbDescription,
  getMessageReads,
  getRecoveryBackup,
  getRoomActiveDevices,
  getRoomDeviceKeys,
  getRoomKeyEpochs,
  getRoomMemberIds,
  getRoomMembers,
  getRoomMessages,
  getUserRoomIds,
  initDatabase,
  insertMessage,
  inviteRoomMembers,
  listPendingLinkRequests,
  listRooms,
  listUserDevices,
  listUsers,
  pingDatabase,
  revokeDevice,
  rotateRoomKey,
  saveRecoveryBackup,
  setRoomDeviceKeys,
  touchDevice,
} from './db.js';

const app = express();
const httpServer = createServer(app);
const allowedOrigin = process.env.CLIENT_ORIGIN || '*';
const io = new Server(httpServer, {
  cors: { origin: allowedOrigin, methods: ['GET', 'POST', 'DELETE'] },
});

app.use(cors({ origin: allowedOrigin }));
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '2mb' }));

const onlineUsers = new Map(); // socketId -> userId
const userSockets = new Map(); // deviceId -> socketId
const legacyChallenges = new Map();

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
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

app.post('/api/devices/legacy-challenge', route(async (req, res) => {
  const user = await findUserById(req.body.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  try {
    const challenge = randomBytes(32);
    const encrypted = publicEncrypt({
      key: createPublicKey({ key: Buffer.from(user.publicKey, 'base64'), format: 'der', type: 'spki' }),
      oaepHash: 'sha256',
    }, challenge);
    const challengeId = uuidv4();
    legacyChallenges.set(challengeId, {
      userId: user.id, proof: challenge.toString('base64'), expiresAt: Date.now() + 5 * 60_000,
    });
    res.json({ challengeId, encryptedChallenge: encrypted.toString('base64') });
  } catch {
    res.status(400).json({ error: 'Invalid legacy public key' });
  }
}));

app.post('/api/devices/legacy-complete', route(async (req, res) => {
  const { challengeId, proof, authToken, deviceName = 'Pierwsze urządzenie' } = req.body;
  const challenge = legacyChallenges.get(challengeId);
  legacyChallenges.delete(challengeId);
  if (!challenge || challenge.expiresAt < Date.now() || challenge.proof !== proof || !authToken) {
    return res.status(401).json({ error: 'Invalid or expired challenge' });
  }
  const user = await findUserById(challenge.userId);
  const existing = (await listUserDevices(user.id)).find((item) => item.publicKey === user.publicKey);
  if (existing) return res.status(409).json({ error: 'Legacy device already migrated' });
  const device = await createDevice({
    id: uuidv4(), userId: user.id, name: deviceName, publicKey: user.publicKey,
    authTokenHash: hashToken(authToken),
  });
  await copyLegacyRoomKeysToDevice(user.id, device.id);
  res.json({ id: user.id, username: user.username, deviceId: device.id });
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
    } });
  }
  res.json({ status: 'pending' });
}));

app.get('/api/device-links', requireAuth, route(async (req, res) => {
  res.json(await listPendingLinkRequests(req.device.userId));
}));

app.post('/api/device-links/:id/approve', requireAuth, route(async (req, res) => {
  const request = await findLinkRequest(req.params.id);
  const { encryptedRoomKeys = [] } = req.body;
  if (!request || request.userId !== req.device.userId || request.expiresAt < Date.now()) {
    return res.status(404).json({ error: 'Link request not found or expired' });
  }
  for (const item of encryptedRoomKeys) {
    if ((await getRoomMemberIds(item.roomId)).includes(request.userId)) {
      await setRoomDeviceKeys(item.roomId, item.keyEpoch, { [request.deviceId]: item.encryptedGroupKey });
    }
  }
  await activateDevice(request.deviceId);
  io.to(`device:${request.deviceId}`).emit('device:link-approved');
  res.json({ ok: true });
}));

app.get('/api/devices', requireAuth, route(async (req, res) => {
  res.json(await listUserDevices(req.device.userId, true));
}));

app.get('/api/devices/me/room-keys', requireAuth, route(async (req, res) => {
  res.json(await getAllDeviceRoomKeys(req.device.id));
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
    encryptedRoomKeys = [],
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
  for (const item of encryptedRoomKeys) {
    if ((await getRoomMemberIds(item.roomId)).includes(user.id)) {
      await setRoomDeviceKeys(item.roomId, item.keyEpoch, { [device.id]: item.encryptedGroupKey });
    }
  }
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

app.get('/api/users', requireAuth, route(async (_req, res) => res.json(await listUsers())));

app.get('/api/rooms', requireAuth, route(async (req, res) => {
  const memberRooms = new Set(await getUserRoomIds(req.device.userId));
  res.json((await listRooms()).filter((room) => memberRooms.has(room.id)));
}));

app.post('/api/rooms', requireAuth, route(async (req, res) => {
  const { name, memberIds = [], encryptedDeviceKeys = {} } = req.body;
  const creatorId = req.device.userId;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  if (name.trim().length > 64) return res.status(400).json({ error: 'Room name is too long' });
  if (!await findUserById(creatorId)) return res.status(404).json({ error: 'Creator not found' });
  const uniqueMemberIds = [...new Set([creatorId, ...memberIds])];
  const users = await Promise.all(uniqueMemberIds.map((id) => findUserById(id)));
  if (users.some((user) => !user)) return res.status(400).json({ error: 'Unknown room member' });
  const deviceGroups = await Promise.all(uniqueMemberIds.map((id) => listUserDevices(id)));
  if (deviceGroups.some((devices) => devices.length === 0)) {
    return res.status(400).json({ error: 'Every room member must have an active device' });
  }
  const activeDevices = deviceGroups.flat();
  const activeDeviceIds = new Set(activeDevices.map((device) => device.id));
  if (activeDevices.some((device) => !encryptedDeviceKeys[device.id])) {
    return res.status(400).json({ error: 'A room key is required for every active device' });
  }
  if (Object.keys(encryptedDeviceKeys).some((deviceId) => !activeDeviceIds.has(deviceId))) {
    return res.status(400).json({ error: 'Room key supplied for a non-member device' });
  }
  const memberMap = Object.fromEntries(uniqueMemberIds.map((id) => [id, null]));
  const room = await createRoom(uuidv4(), name, creatorId, memberMap, encryptedDeviceKeys);
  res.json({ id: room.id, name: room.name });
}));

app.get('/api/rooms/:roomId/devices', requireAuth, route(async (req, res) => {
  if (!(await getRoomMemberIds(req.params.roomId)).includes(req.device.userId)) {
    return res.status(403).json({ error: 'Not a room member' });
  }
  res.json(await getRoomActiveDevices(req.params.roomId));
}));

app.post('/api/rooms/:roomId/members', requireAuth, route(async (req, res) => {
  const roomId = req.params.roomId;
  const room = await findRoomById(roomId);
  if (!room || room.creatorId !== req.device.userId) {
    return res.status(403).json({ error: 'Only the room creator can invite members' });
  }
  const existingMembers = new Set(await getRoomMemberIds(roomId));
  const userIds = [...new Set(req.body.userIds || [])].filter((id) => !existingMembers.has(id));
  if (!userIds.length) return res.status(400).json({ error: 'No new members selected' });
  const invitedUsers = await Promise.all(userIds.map((id) => findUserById(id)));
  if (invitedUsers.some((user) => !user)) return res.status(400).json({ error: 'Unknown user in invitation' });
  const targetDevices = (await Promise.all(userIds.map((id) => listUserDevices(id)))).flat();
  if (!targetDevices.length || userIds.some((id) => !targetDevices.some((device) => device.userId === id))) {
    return res.status(400).json({ error: 'Every invited user must have an active device' });
  }
  const targetDeviceIds = new Set(targetDevices.map((device) => device.id));
  const epochs = await getRoomKeyEpochs(roomId);
  const encryptedRoomKeys = req.body.encryptedRoomKeys || [];
  const supplied = new Set(encryptedRoomKeys.map((item) => `${item.deviceId}:${item.keyEpoch}`));
  const complete = epochs.every((epoch) => [...targetDeviceIds].every((id) => supplied.has(`${id}:${epoch}`)));
  const valid = encryptedRoomKeys.every((item) =>
    targetDeviceIds.has(item.deviceId) && epochs.includes(item.keyEpoch) && item.encryptedGroupKey
  );
  if (!epochs.length || !complete || !valid) {
    return res.status(400).json({ error: 'A key for every device and epoch is required' });
  }
  await inviteRoomMembers(roomId, userIds, encryptedRoomKeys);
  const members = await getRoomMembers(roomId);
  io.to(`room:${roomId}`).emit('room:members-updated', { roomId, members });
  for (const userId of userIds) io.to(`user:${userId}`).emit('room:invited', { roomId });
  res.json({ members });
}));

app.post('/api/rooms/:roomId/rotate-key', requireAuth, route(async (req, res) => {
  const roomId = req.params.roomId;
  const room = await findRoomById(roomId);
  if (!room || !(await getRoomMemberIds(roomId)).includes(req.device.userId)) {
    return res.status(403).json({ error: 'Not a room member' });
  }
  const nextEpoch = room.currentEpoch + 1;
  if (!await rotateRoomKey(roomId, nextEpoch, req.body.encryptedDeviceKeys || {})) {
    return res.status(409).json({ error: 'Room key rotation is incomplete or stale' });
  }
  for (const [deviceId, encryptedGroupKey] of Object.entries(req.body.encryptedDeviceKeys || {})) {
    io.to(`device:${deviceId}`).emit('room:key-rotated', { roomId, keyEpoch: nextEpoch, encryptedGroupKey });
  }
  res.json({ keyEpoch: nextEpoch });
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
      findRoomById(roomId), findUserById(userId), getRoomMemberIds(roomId),
    ]);
    if (!room || !user || !memberIds.includes(userId)) return;
    socket.join(`room:${roomId}`);
    const [storedKeys, messages, members] = await Promise.all([
      getRoomDeviceKeys(roomId, deviceId), getRoomMessages(roomId), getRoomMembers(roomId),
    ]);
    socket.emit('room:history', {
      roomId, messages, members, encryptedGroupKeys: storedKeys,
      currentEpoch: room.currentEpoch, rotationRequired: room.rotationRequired,
    });
    socket.to(`room:${roomId}`).emit('room:member-joined', { userId, username: user.username, members });
    if (!storedKeys.length) {
      socket.to(`room:${roomId}`).emit('room:key-needed', {
        roomId, requesterId: userId, requesterDeviceId: deviceId,
        requesterPublicKey: socket.device.publicKey,
      });
    }
    io.to(`room:${roomId}`).emit('room:online', {
      roomId, onlineUserIds: await getRoomOnlineUserIds(roomId),
    });
  });

  onSocket(socket, 'room:share-key', async ({ roomId, targetDeviceId, encryptedGroupKeys }) => {
    if (!await findRoomById(roomId) || !(await getRoomMemberIds(roomId)).includes(userId)) return;
    const target = await findDeviceById(targetDeviceId);
    if (!target || !(await getRoomMemberIds(roomId)).includes(target.userId)) return;
    for (const item of encryptedGroupKeys || []) {
      await setRoomDeviceKeys(roomId, item.keyEpoch, { [targetDeviceId]: item.encryptedGroupKey });
    }
    io.to(`device:${targetDeviceId}`).emit('room:key-received', { roomId, encryptedGroupKeys });
  });

  onSocket(socket, 'room:leave', async ({ roomId }) => {
    socket.leave(`room:${roomId}`);
    io.to(`room:${roomId}`).emit('room:online', {
      roomId, onlineUserIds: await getRoomOnlineUserIds(roomId),
    });
  });

  onSocket(socket, 'message:send', async ({ roomId, message }) => {
    const room = await findRoomById(roomId);
    if (!room || !(await getRoomMemberIds(roomId)).includes(userId) || room.rotationRequired) return;
    if (message.keyEpoch !== room.currentEpoch) return;
    const stored = {
      id: message.id || uuidv4(), roomId, senderId: userId, senderDeviceId: deviceId,
      senderUsername: socket.device.username, ciphertext: message.ciphertext, iv: message.iv,
      timestamp: message.timestamp || Date.now(), keyEpoch: message.keyEpoch,
      readBy: [{ userId, username: socket.device.username, readAt: Date.now() }],
    };
    await insertMessage(stored);
    io.to(`room:${roomId}`).emit('message:new', stored);
  });

  onSocket(socket, 'message:read', async ({ roomId, messageId }) => {
    if (!await findRoomById(roomId) || !(await getRoomMemberIds(roomId)).includes(userId)) return;
    await addMessageRead(messageId, userId, socket.device.username, Date.now());
    io.to(`room:${roomId}`).emit('message:read-update', {
      messageId, readBy: await getMessageReads(messageId),
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
