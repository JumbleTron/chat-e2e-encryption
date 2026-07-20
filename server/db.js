import mysql from 'mysql2/promise';

const config = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || process.env.MYSQL_USER || 'message_app',
  password: process.env.DB_PASSWORD || process.env.MYSQL_PASSWORD || 'message_app',
  database: process.env.DB_NAME || process.env.MYSQL_DATABASE || 'message_app',
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  queueLimit: 0,
  enableKeepAlive: true,
};

if (!/^[a-zA-Z0-9_]+$/.test(config.database)) throw new Error('DB_NAME contains invalid characters');

const pool = mysql.createPool(config);

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(36) PRIMARY KEY,
    username VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL UNIQUE,
    public_key TEXT NOT NULL,
    created_at BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS rooms (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(64) NOT NULL,
    creator_id VARCHAR(36) NOT NULL,
    current_epoch INT NOT NULL DEFAULT 1,
    rotation_required BOOLEAN NOT NULL DEFAULT FALSE,
    created_at BIGINT NOT NULL,
    CONSTRAINT fk_rooms_creator FOREIGN KEY (creator_id) REFERENCES users(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS user_devices (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    name VARCHAR(64) NOT NULL,
    public_key TEXT NOT NULL,
    auth_token_hash CHAR(64) NOT NULL UNIQUE,
    status ENUM('pending', 'active', 'revoked') NOT NULL DEFAULT 'active',
    created_at BIGINT NOT NULL,
    last_seen_at BIGINT NULL,
    INDEX idx_user_devices_user (user_id, status),
    CONSTRAINT fk_devices_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS room_members (
    room_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    encrypted_group_key LONGTEXT NULL,
    joined_at BIGINT NOT NULL,
    PRIMARY KEY (room_id, user_id),
    INDEX idx_room_members_user (user_id),
    CONSTRAINT fk_room_members_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    CONSTRAINT fk_room_members_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS device_link_requests (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    device_id VARCHAR(36) NOT NULL UNIQUE,
    verification_code CHAR(6) NOT NULL,
    expires_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    CONSTRAINT fk_link_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_link_device FOREIGN KEY (device_id) REFERENCES user_devices(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS room_device_keys (
    room_id VARCHAR(36) NOT NULL,
    device_id VARCHAR(36) NOT NULL,
    key_epoch INT NOT NULL DEFAULT 1,
    encrypted_group_key LONGTEXT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (room_id, device_id, key_epoch),
    INDEX idx_room_device_keys_device (device_id, room_id),
    CONSTRAINT fk_room_keys_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    CONSTRAINT fk_room_keys_device FOREIGN KEY (device_id) REFERENCES user_devices(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS messages (
    id VARCHAR(36) PRIMARY KEY,
    room_id VARCHAR(36) NOT NULL,
    sender_id VARCHAR(36) NOT NULL,
    sender_username VARCHAR(32) NOT NULL,
    sender_device_id VARCHAR(36) NULL,
    ciphertext LONGTEXT NOT NULL,
    iv TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    key_epoch INT NOT NULL DEFAULT 1,
    INDEX idx_messages_room_timestamp (room_id, timestamp),
    CONSTRAINT fk_messages_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    CONSTRAINT fk_messages_sender FOREIGN KEY (sender_id) REFERENCES users(id),
    CONSTRAINT fk_messages_device FOREIGN KEY (sender_device_id) REFERENCES user_devices(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS message_reads (
    message_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    username VARCHAR(32) NOT NULL,
    read_at BIGINT NOT NULL,
    PRIMARY KEY (message_id, user_id),
    CONSTRAINT fk_reads_message FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    CONSTRAINT fk_reads_user FOREIGN KEY (user_id) REFERENCES users(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS recovery_backups (
    user_id VARCHAR(36) PRIMARY KEY,
    ciphertext LONGTEXT NOT NULL,
    iv TEXT NOT NULL,
    recovery_auth_hash CHAR(64) NOT NULL,
    updated_at BIGINT NOT NULL,
    CONSTRAINT fk_recovery_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
];

export async function initDatabase({ attempts = 30, delayMs = 2000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (process.env.DB_AUTO_CREATE === 'true') {
        const connection = await mysql.createConnection({
          host: config.host, port: config.port, user: config.user, password: config.password,
        });
        await connection.query(
          `CREATE DATABASE IF NOT EXISTS \`${config.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`
        );
        await connection.end();
      }
      for (const statement of schemaStatements) await pool.query(statement);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`MySQL initialization failed: ${lastError?.message || 'unknown error'}`);
}

export async function pingDatabase() {
  await pool.query('SELECT 1');
}

async function first(sql, params = [], executor = pool) {
  const [rows] = await executor.query(sql, params);
  return rows[0] || null;
}

async function rows(sql, params = [], executor = pool) {
  const [result] = await executor.query(sql, params);
  return result;
}

async function withTransaction(callback) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export function findUserByUsername(username) {
  return first('SELECT id, username, public_key AS publicKey FROM users WHERE username = ?', [username.trim()]);
}

export function findUserById(id) {
  return first('SELECT id, username, public_key AS publicKey FROM users WHERE id = ?', [id]);
}

export async function createUser(id, username, publicKey) {
  const normalized = username.trim();
  await pool.query(
    'INSERT INTO users (id, username, public_key, created_at) VALUES (?, ?, ?, ?)',
    [id, normalized, publicKey, Date.now()]
  );
  return { id, username: normalized };
}

export async function listUsers() {
  const users = await rows('SELECT id, username FROM users ORDER BY username');
  return Promise.all(users.map(async (user) => ({
    ...user,
    devices: await rows(
      `SELECT id, name, public_key AS publicKey FROM user_devices
       WHERE user_id = ? AND status = 'active' ORDER BY created_at`,
      [user.id]
    ),
  })));
}

export async function createDevice({ id, userId, name, publicKey, authTokenHash, status = 'active' }) {
  await pool.query(
    `INSERT INTO user_devices
     (id, user_id, name, public_key, auth_token_hash, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, name.trim(), publicKey, authTokenHash, status, Date.now()]
  );
  return findDeviceById(id);
}

export function findDeviceById(id) {
  return first(
    `SELECT id, user_id AS userId, name, public_key AS publicKey, status,
            created_at AS createdAt, last_seen_at AS lastSeenAt
     FROM user_devices WHERE id = ?`, [id]
  );
}

export function findDeviceByTokenHash(authTokenHash) {
  return first(
    `SELECT d.id, d.user_id AS userId, d.name, d.public_key AS publicKey, d.status,
            u.username FROM user_devices d JOIN users u ON u.id = d.user_id
     WHERE d.auth_token_hash = ?`, [authTokenHash]
  );
}

export function listUserDevices(userId, includePending = false) {
  const statuses = includePending ? ['active', 'pending'] : ['active'];
  return rows(
    `SELECT id, user_id AS userId, name, public_key AS publicKey, status,
            created_at AS createdAt, last_seen_at AS lastSeenAt
     FROM user_devices WHERE user_id = ? AND status IN (?) ORDER BY created_at`,
    [userId, statuses]
  );
}

export async function touchDevice(deviceId, timestamp = Date.now()) {
  await pool.query('UPDATE user_devices SET last_seen_at = ? WHERE id = ?', [timestamp, deviceId]);
}

export async function activateDevice(deviceId) {
  await pool.query("UPDATE user_devices SET status = 'active' WHERE id = ? AND status = 'pending'", [deviceId]);
}

export function revokeDevice(deviceId, userId) {
  return withTransaction(async (connection) => {
    const device = await first(
      'SELECT id, user_id AS userId, status FROM user_devices WHERE id = ? FOR UPDATE',
      [deviceId], connection
    );
    if (!device || device.userId !== userId || device.status !== 'active') return [];
    const countRow = await first(
      "SELECT COUNT(*) AS count FROM user_devices WHERE user_id = ? AND status = 'active'",
      [userId], connection
    );
    if (Number(countRow.count) <= 1) throw new Error('LAST_DEVICE');
    await connection.query("UPDATE user_devices SET status = 'revoked' WHERE id = ?", [deviceId]);
    const roomRows = await rows(
      'SELECT DISTINCT room_id AS roomId FROM room_device_keys WHERE device_id = ?',
      [deviceId], connection
    );
    for (const room of roomRows) {
      await connection.query('UPDATE rooms SET rotation_required = TRUE WHERE id = ?', [room.roomId]);
    }
    return roomRows.map((room) => room.roomId);
  });
}

export async function createLinkRequest({ id, userId, deviceId, verificationCode, expiresAt }) {
  await pool.query(
    `INSERT INTO device_link_requests
     (id, user_id, device_id, verification_code, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, userId, deviceId, verificationCode, expiresAt, Date.now()]
  );
}

export function findLinkRequest(id) {
  return first(
    `SELECT lr.id, lr.user_id AS userId, lr.device_id AS deviceId,
            lr.verification_code AS verificationCode, lr.expires_at AS expiresAt,
            d.name AS deviceName, d.public_key AS publicKey, d.status
     FROM device_link_requests lr JOIN user_devices d ON d.id = lr.device_id
     WHERE lr.id = ?`, [id]
  );
}

export function listPendingLinkRequests(userId) {
  return rows(
    `SELECT lr.id, lr.device_id AS deviceId, lr.verification_code AS verificationCode,
            lr.expires_at AS expiresAt, d.name AS deviceName, d.public_key AS publicKey
     FROM device_link_requests lr JOIN user_devices d ON d.id = lr.device_id
     WHERE lr.user_id = ? AND d.status = 'pending' AND lr.expires_at > ?
     ORDER BY lr.created_at DESC`, [userId, Date.now()]
  );
}

export async function saveRecoveryBackup(userId, ciphertext, iv, recoveryAuthHash) {
  await pool.query(
    `INSERT INTO recovery_backups
     (user_id, ciphertext, iv, recovery_auth_hash, updated_at) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE ciphertext = VALUES(ciphertext), iv = VALUES(iv),
       recovery_auth_hash = VALUES(recovery_auth_hash), updated_at = VALUES(updated_at)`,
    [userId, ciphertext, iv, recoveryAuthHash, Date.now()]
  );
}

export function getRecoveryBackup(userId) {
  return first(
    `SELECT user_id AS userId, ciphertext, iv, recovery_auth_hash AS recoveryAuthHash,
            updated_at AS updatedAt FROM recovery_backups WHERE user_id = ?`, [userId]
  );
}

export async function listRooms() {
  const result = await rows(
    `SELECT r.id, r.name, r.creator_id AS creatorId, r.current_epoch AS currentEpoch,
            r.rotation_required AS rotationRequired, COUNT(rm.user_id) AS memberCount
     FROM rooms r LEFT JOIN room_members rm ON rm.room_id = r.id
     GROUP BY r.id, r.name, r.creator_id, r.current_epoch, r.rotation_required, r.created_at
     ORDER BY r.created_at DESC`
  );
  return result.map((room) => ({
    ...room, memberCount: Number(room.memberCount), rotationRequired: Boolean(room.rotationRequired),
  }));
}

export function createRoom(id, name, creatorId, encryptedGroupKeys = {}, encryptedDeviceKeys = {}) {
  return withTransaction(async (connection) => {
    const normalized = name.trim();
    const timestamp = Date.now();
    await connection.query(
      'INSERT INTO rooms (id, name, creator_id, current_epoch, rotation_required, created_at) VALUES (?, ?, ?, 1, FALSE, ?)',
      [id, normalized, creatorId, timestamp]
    );
    for (const userId of new Set([creatorId, ...Object.keys(encryptedGroupKeys)])) {
      await connection.query(
        `INSERT INTO room_members (room_id, user_id, encrypted_group_key, joined_at)
         VALUES (?, ?, ?, ?)`,
        [id, userId, encryptedGroupKeys[userId] || null, timestamp]
      );
    }
    for (const [deviceId, encryptedKey] of Object.entries(encryptedDeviceKeys)) {
      await upsertRoomDeviceKey(connection, id, deviceId, 1, encryptedKey);
    }
    return { id, name: normalized };
  });
}

export async function findRoomById(roomId) {
  const room = await first(
    `SELECT id, name, creator_id AS creatorId, current_epoch AS currentEpoch,
            rotation_required AS rotationRequired FROM rooms WHERE id = ?`, [roomId]
  );
  return room ? { ...room, rotationRequired: Boolean(room.rotationRequired) } : null;
}

export async function getRoomMemberIds(roomId, executor = pool) {
  const result = await rows('SELECT user_id AS userId FROM room_members WHERE room_id = ?', [roomId], executor);
  return result.map((row) => row.userId);
}

export async function getRoomMembers(roomId) {
  const members = await rows(
    `SELECT u.id, u.username, u.public_key AS publicKey FROM room_members rm
     JOIN users u ON u.id = rm.user_id WHERE rm.room_id = ?`, [roomId]
  );
  return Promise.all(members.map(async (member) => ({
    ...member,
    devices: await rows(
      `SELECT id, name, public_key AS publicKey FROM user_devices
       WHERE user_id = ? AND status = 'active' ORDER BY created_at`, [member.id]
    ),
  })));
}

export function getRoomActiveDevices(roomId, executor = pool) {
  return rows(
    `SELECT d.id, d.user_id AS userId, d.name, d.public_key AS publicKey
     FROM room_members rm JOIN user_devices d ON d.user_id = rm.user_id
     WHERE rm.room_id = ? AND d.status = 'active' ORDER BY d.created_at`, [roomId], executor
  );
}

export async function getRoomKeyEpochs(roomId) {
  const result = await rows(
    'SELECT DISTINCT key_epoch AS keyEpoch FROM room_device_keys WHERE room_id = ? ORDER BY key_epoch', [roomId]
  );
  return result.map((row) => row.keyEpoch);
}

export function inviteRoomMembers(roomId, userIds, encryptedRoomKeys) {
  return withTransaction(async (connection) => {
    const timestamp = Date.now();
    for (const userId of userIds) {
      await connection.query(
        `INSERT IGNORE INTO room_members (room_id, user_id, encrypted_group_key, joined_at)
         VALUES (?, ?, NULL, ?)`, [roomId, userId, timestamp]
      );
    }
    for (const item of encryptedRoomKeys) {
      await upsertRoomDeviceKey(connection, roomId, item.deviceId, item.keyEpoch, item.encryptedGroupKey);
    }
  });
}

async function upsertRoomDeviceKey(executor, roomId, deviceId, keyEpoch, encryptedGroupKey) {
  await executor.query(
    `INSERT INTO room_device_keys
     (room_id, device_id, key_epoch, encrypted_group_key, created_at) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE encrypted_group_key = VALUES(encrypted_group_key)`,
    [roomId, deviceId, keyEpoch, encryptedGroupKey, Date.now()]
  );
}

export async function setRoomDeviceKeys(roomId, keyEpoch, encryptedDeviceKeys, executor = pool) {
  for (const [deviceId, encryptedKey] of Object.entries(encryptedDeviceKeys)) {
    await upsertRoomDeviceKey(executor, roomId, deviceId, keyEpoch, encryptedKey);
  }
}

export function getRoomDeviceKeys(roomId, deviceId) {
  return rows(
    `SELECT key_epoch AS keyEpoch, encrypted_group_key AS encryptedGroupKey
     FROM room_device_keys WHERE room_id = ? AND device_id = ? ORDER BY key_epoch`,
    [roomId, deviceId]
  );
}

export function getAllDeviceRoomKeys(deviceId) {
  return rows(
    `SELECT room_id AS roomId, key_epoch AS keyEpoch, encrypted_group_key AS encryptedGroupKey
     FROM room_device_keys WHERE device_id = ? ORDER BY room_id, key_epoch`, [deviceId]
  );
}

export async function copyLegacyRoomKeysToDevice(userId, deviceId) {
  await pool.query(
    `INSERT IGNORE INTO room_device_keys
     (room_id, device_id, key_epoch, encrypted_group_key, created_at)
     SELECT room_id, ?, 1, encrypted_group_key, ? FROM room_members
     WHERE user_id = ? AND encrypted_group_key IS NOT NULL`, [deviceId, Date.now(), userId]
  );
}

export function rotateRoomKey(roomId, expectedEpoch, encryptedDeviceKeys) {
  return withTransaction(async (connection) => {
    const room = await first(
      'SELECT current_epoch AS currentEpoch FROM rooms WHERE id = ? FOR UPDATE', [roomId], connection
    );
    if (!room || room.currentEpoch !== expectedEpoch - 1) return false;
    const devices = await getRoomActiveDevices(roomId, connection);
    const allowed = new Set(devices.map((device) => device.id));
    if (!allowed.size || [...allowed].some((id) => !encryptedDeviceKeys[id])) return false;
    if (Object.keys(encryptedDeviceKeys).some((id) => !allowed.has(id))) return false;
    await setRoomDeviceKeys(roomId, expectedEpoch, encryptedDeviceKeys, connection);
    await connection.query(
      'UPDATE rooms SET current_epoch = ?, rotation_required = FALSE WHERE id = ?', [expectedEpoch, roomId]
    );
    return true;
  });
}

export async function getUserRoomIds(userId) {
  const result = await rows('SELECT room_id AS roomId FROM room_members WHERE user_id = ?', [userId]);
  return result.map((row) => row.roomId);
}

export async function getRoomMessages(roomId) {
  const messages = await rows(
    `SELECT id, room_id AS roomId, sender_id AS senderId, sender_username AS senderUsername,
            ciphertext, iv, timestamp, key_epoch AS keyEpoch, sender_device_id AS senderDeviceId
     FROM messages WHERE room_id = ? ORDER BY timestamp`, [roomId]
  );
  return Promise.all(messages.map(async (message) => ({
    ...message,
    readBy: await rows(
      `SELECT user_id AS userId, username, read_at AS readAt
       FROM message_reads WHERE message_id = ?`, [message.id]
    ),
  })));
}

export function insertMessage(message) {
  return withTransaction(async (connection) => {
    const {
      id, roomId, senderId, senderUsername, senderDeviceId,
      ciphertext, iv, timestamp, keyEpoch, readBy,
    } = message;
    await connection.query(
      `INSERT INTO messages
       (id, room_id, sender_id, sender_username, sender_device_id, ciphertext, iv, timestamp, key_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, roomId, senderId, senderUsername, senderDeviceId, ciphertext, iv, timestamp, keyEpoch]
    );
    for (const read of readBy) {
      await connection.query(
        `INSERT IGNORE INTO message_reads (message_id, user_id, username, read_at)
         VALUES (?, ?, ?, ?)`, [id, read.userId, read.username, read.readAt]
      );
    }
    return message;
  });
}

export async function addMessageRead(messageId, userId, username, readAt) {
  await pool.query(
    `INSERT IGNORE INTO message_reads (message_id, user_id, username, read_at)
     VALUES (?, ?, ?, ?)`, [messageId, userId, username, readAt]
  );
}

export function getMessageReads(messageId) {
  return rows(
    'SELECT user_id AS userId, username, read_at AS readAt FROM message_reads WHERE message_id = ?',
    [messageId]
  );
}

export function getDbDescription() {
  return `mysql://${config.user}@${config.host}:${config.port}/${config.database}`;
}

export async function closeDatabase() {
  await pool.end();
}

export default pool;
