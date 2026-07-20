import mysql from 'mysql2/promise';
import { createHash } from 'crypto';

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
    joined_at BIGINT NOT NULL,
    PRIMARY KEY (room_id, user_id),
    INDEX idx_room_members_user (user_id),
    CONSTRAINT fk_room_members_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    CONSTRAINT fk_room_members_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS room_pending_members (
    room_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    invited_by_device_id VARCHAR(36) NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (room_id, user_id),
    CONSTRAINT fk_pending_member_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    CONSTRAINT fk_pending_member_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_pending_member_inviter FOREIGN KEY (invited_by_device_id)
      REFERENCES user_devices(id) ON DELETE CASCADE
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
  `CREATE TABLE IF NOT EXISTS recovery_backups (
    user_id VARCHAR(36) PRIMARY KEY,
    ciphertext LONGTEXT NOT NULL,
    iv TEXT NOT NULL,
    recovery_auth_hash CHAR(64) NOT NULL,
    updated_at BIGINT NOT NULL,
    CONSTRAINT fk_recovery_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS mls_user_profiles (
    user_id VARCHAR(36) PRIMARY KEY,
    mls_user_id VARBINARY(64) NOT NULL UNIQUE,
    created_at BIGINT NOT NULL,
    CONSTRAINT fk_mls_user_profile FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS mls_device_profiles (
    device_id VARCHAR(36) PRIMARY KEY,
    mls_device_id VARBINARY(64) NOT NULL UNIQUE,
    created_at BIGINT NOT NULL,
    CONSTRAINT fk_mls_device_profile FOREIGN KEY (device_id) REFERENCES user_devices(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS mls_key_packages (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    device_id VARCHAR(36) NOT NULL,
    package_hash CHAR(64) NOT NULL UNIQUE,
    key_package LONGBLOB NOT NULL,
    is_last_resort BOOLEAN NOT NULL DEFAULT FALSE,
    claimed_at BIGINT NULL,
    created_at BIGINT NOT NULL,
    INDEX idx_mls_packages_available (device_id, is_last_resort, claimed_at),
    CONSTRAINT fk_mls_package_device FOREIGN KEY (device_id) REFERENCES user_devices(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS mls_conversations (
    room_id VARCHAR(36) PRIMARY KEY,
    conversation_id VARBINARY(64) NOT NULL UNIQUE,
    created_at BIGINT NOT NULL,
    CONSTRAINT fk_mls_conversation_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS mls_envelopes (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    conversation_id VARBINARY(64) NOT NULL,
    version SMALLINT UNSIGNED NOT NULL,
    epoch BIGINT UNSIGNED NOT NULL,
    kind ENUM('Application', 'Commit', 'Welcome', 'Proposal', 'KeyPackage') NOT NULL,
    sender_mls_device_id VARBINARY(64) NOT NULL,
    sequence_number BIGINT UNSIGNED NOT NULL,
    wall_time BIGINT NOT NULL,
    logical_time INT UNSIGNED NOT NULL,
    payload LONGBLOB NOT NULL,
    content_hash VARBINARY(64) NOT NULL,
    created_at BIGINT NOT NULL,
    UNIQUE KEY uq_mls_sender_sequence (conversation_id, sender_mls_device_id, sequence_number, kind),
    INDEX idx_mls_envelopes_sync (conversation_id, id),
    CONSTRAINT fk_mls_envelope_conversation FOREIGN KEY (conversation_id)
      REFERENCES mls_conversations(conversation_id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS mls_envelope_recipients (
    envelope_id BIGINT UNSIGNED NOT NULL,
    mls_device_id VARBINARY(64) NOT NULL,
    acknowledged_at BIGINT NULL,
    PRIMARY KEY (envelope_id, mls_device_id),
    INDEX idx_mls_welcome_recipient (mls_device_id, acknowledged_at),
    CONSTRAINT fk_mls_recipient_envelope FOREIGN KEY (envelope_id) REFERENCES mls_envelopes(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS mls_message_reads (
    message_id VARCHAR(36) NOT NULL,
    room_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    username VARCHAR(32) NOT NULL,
    read_at BIGINT NOT NULL,
    PRIMARY KEY (message_id, user_id),
    INDEX idx_mls_reads_room (room_id, message_id),
    CONSTRAINT fk_mls_reads_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    CONSTRAINT fk_mls_reads_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS mls_device_link_secrets (
    request_id VARCHAR(36) PRIMARY KEY,
    encrypted_identity LONGTEXT NOT NULL,
    approving_device_id VARCHAR(36) NOT NULL,
    created_at BIGINT NOT NULL,
    CONSTRAINT fk_mls_link_request FOREIGN KEY (request_id) REFERENCES device_link_requests(id) ON DELETE CASCADE,
    CONSTRAINT fk_mls_link_approver FOREIGN KEY (approving_device_id) REFERENCES user_devices(id) ON DELETE CASCADE
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
  const users = await rows(
    `SELECT u.id, u.username, up.mls_user_id AS mlsUserId
     FROM users u LEFT JOIN mls_user_profiles up ON up.user_id = u.id ORDER BY u.username`
  );
  return Promise.all(users.map(async (user) => ({
    ...user,
    devices: await rows(
      `SELECT d.id, d.name, d.public_key AS publicKey, dp.mls_device_id AS mlsDeviceId
       FROM user_devices d LEFT JOIN mls_device_profiles dp ON dp.device_id = d.id
       WHERE d.user_id = ? AND d.status = 'active' ORDER BY d.created_at`,
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
      `SELECT rm.room_id AS roomId FROM room_members rm
       JOIN mls_conversations mc ON mc.room_id = rm.room_id WHERE rm.user_id = ?`,
      [userId], connection
    );
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
            d.name AS deviceName, d.public_key AS publicKey, d.status,
            ls.encrypted_identity AS encryptedMlsIdentity,
            ls.approving_device_id AS approvingDeviceId
     FROM device_link_requests lr JOIN user_devices d ON d.id = lr.device_id
     LEFT JOIN mls_device_link_secrets ls ON ls.request_id = lr.id
     WHERE lr.id = ?`, [id]
  );
}

export async function saveMlsLinkSecret(requestId, encryptedIdentity, approvingDeviceId) {
  await pool.query(
    `INSERT INTO mls_device_link_secrets
     (request_id, encrypted_identity, approving_device_id, created_at) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE encrypted_identity = VALUES(encrypted_identity),
       approving_device_id = VALUES(approving_device_id), created_at = VALUES(created_at)`,
    [requestId, encryptedIdentity, approvingDeviceId, Date.now()]
  );
}

export function getMlsLinkApprover(deviceId) {
  return first(
    `SELECT ls.approving_device_id AS approvingDeviceId
     FROM device_link_requests lr
     JOIN mls_device_link_secrets ls ON ls.request_id = lr.id
     WHERE lr.device_id = ?`, [deviceId]
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
            r.rotation_required AS rotationRequired, COUNT(rm.user_id) AS memberCount,
            mc.conversation_id AS conversationId
     FROM rooms r LEFT JOIN room_members rm ON rm.room_id = r.id
     LEFT JOIN mls_conversations mc ON mc.room_id = r.id
     GROUP BY r.id, r.name, r.creator_id, r.current_epoch, r.rotation_required,
              r.created_at, mc.conversation_id
     ORDER BY r.created_at DESC`
  );
  return result.map((room) => ({
    ...room, memberCount: Number(room.memberCount), rotationRequired: Boolean(room.rotationRequired),
  }));
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

export async function getUserRoomIds(userId) {
  const result = await rows('SELECT room_id AS roomId FROM room_members WHERE user_id = ?', [userId]);
  return result.map((row) => row.roomId);
}

export function getDbDescription() {
  return `mysql://${config.user}@${config.host}:${config.port}/${config.database}`;
}

export async function closeDatabase() {
  await pool.end();
}

export function getMlsProfile(deviceId) {
  return first(
    `SELECT up.mls_user_id AS mlsUserId, dp.mls_device_id AS mlsDeviceId,
            (SELECT COUNT(*) FROM mls_key_packages kp
             WHERE kp.device_id = d.id AND kp.claimed_at IS NULL AND kp.is_last_resort = FALSE) AS availablePackages
     FROM user_devices d
     LEFT JOIN mls_user_profiles up ON up.user_id = d.user_id
     LEFT JOIN mls_device_profiles dp ON dp.device_id = d.id
     WHERE d.id = ?`,
    [deviceId]
  );
}

export function registerMlsProfile({ userId, deviceId, mlsUserId, mlsDeviceId }) {
  return withTransaction(async (connection) => {
    const existingUser = await first(
      'SELECT mls_user_id AS mlsUserId FROM mls_user_profiles WHERE user_id = ? FOR UPDATE',
      [userId], connection
    );
    if (existingUser && !Buffer.from(existingUser.mlsUserId).equals(mlsUserId)) {
      throw new Error('MLS_USER_ID_MISMATCH');
    }
    const existingDevice = await first(
      'SELECT mls_device_id AS mlsDeviceId FROM mls_device_profiles WHERE device_id = ? FOR UPDATE',
      [deviceId], connection
    );
    if (existingDevice && !Buffer.from(existingDevice.mlsDeviceId).equals(mlsDeviceId)) {
      throw new Error('MLS_DEVICE_ID_MISMATCH');
    }
    await connection.query(
      `INSERT IGNORE INTO mls_user_profiles (user_id, mls_user_id, created_at) VALUES (?, ?, ?)`,
      [userId, mlsUserId, Date.now()]
    );
    await connection.query(
      `INSERT IGNORE INTO mls_device_profiles (device_id, mls_device_id, created_at) VALUES (?, ?, ?)`,
      [deviceId, mlsDeviceId, Date.now()]
    );
  });
}

export async function addMlsKeyPackages(deviceId, keyPackages, lastResortKeyPackage = null) {
  const values = keyPackages.map((keyPackage) => ({ keyPackage, lastResort: false }));
  if (lastResortKeyPackage) values.push({ keyPackage: lastResortKeyPackage, lastResort: true });
  for (const item of values) {
    const hash = createHash('sha256').update(item.keyPackage).digest('hex');
    await pool.query(
      `INSERT IGNORE INTO mls_key_packages
       (device_id, package_hash, key_package, is_last_resort, created_at) VALUES (?, ?, ?, ?, ?)`,
      [deviceId, hash, item.keyPackage, item.lastResort, Date.now()]
    );
  }
}

export function claimMlsDevices(mlsUserId) {
  return withTransaction(async (connection) => {
    const devices = await rows(
      `SELECT d.id AS deviceId, dp.mls_device_id AS mlsDeviceId
       FROM mls_user_profiles up
       JOIN user_devices d ON d.user_id = up.user_id AND d.status = 'active'
       JOIN mls_device_profiles dp ON dp.device_id = d.id
       WHERE up.mls_user_id = ? FOR UPDATE`,
      [mlsUserId], connection
    );
    const result = [];
    for (const device of devices) {
      let keyPackage = await first(
        `SELECT id, key_package AS keyPackage, is_last_resort AS isLastResort
         FROM mls_key_packages
         WHERE device_id = ? AND claimed_at IS NULL AND is_last_resort = FALSE
         ORDER BY id LIMIT 1 FOR UPDATE`, [device.deviceId], connection
      );
      if (!keyPackage) {
        keyPackage = await first(
          `SELECT id, key_package AS keyPackage, is_last_resort AS isLastResort
           FROM mls_key_packages WHERE device_id = ? AND is_last_resort = TRUE
           ORDER BY id DESC LIMIT 1`, [device.deviceId], connection
        );
      }
      if (!keyPackage) continue;
      if (!keyPackage.isLastResort) {
        await connection.query('UPDATE mls_key_packages SET claimed_at = ? WHERE id = ?', [Date.now(), keyPackage.id]);
      }
      result.push({ mlsDeviceId: device.mlsDeviceId, keyPackage: keyPackage.keyPackage });
    }
    return result;
  });
}

export function claimMlsDevice(deviceId, userId) {
  return withTransaction(async (connection) => {
    const device = await first(
      `SELECT dp.mls_device_id AS mlsDeviceId FROM user_devices d
       JOIN mls_device_profiles dp ON dp.device_id = d.id
       WHERE d.id = ? AND d.user_id = ? AND d.status = 'active' FOR UPDATE`,
      [deviceId, userId], connection
    );
    if (!device) return null;
    let keyPackage = await first(
      `SELECT id, key_package AS keyPackage, is_last_resort AS isLastResort
       FROM mls_key_packages WHERE device_id = ? AND claimed_at IS NULL AND is_last_resort = FALSE
       ORDER BY id LIMIT 1 FOR UPDATE`, [deviceId], connection
    );
    if (!keyPackage) {
      keyPackage = await first(
        `SELECT id, key_package AS keyPackage, is_last_resort AS isLastResort
         FROM mls_key_packages WHERE device_id = ? AND is_last_resort = TRUE ORDER BY id DESC LIMIT 1`,
        [deviceId], connection
      );
    }
    if (!keyPackage) return null;
    if (!keyPackage.isLastResort) {
      await connection.query('UPDATE mls_key_packages SET claimed_at = ? WHERE id = ?', [Date.now(), keyPackage.id]);
    }
    return { ...device, keyPackage: keyPackage.keyPackage };
  });
}

export function createMlsRoom(id, name, creatorId, creatorDeviceId, memberIds, conversationId) {
  return withTransaction(async (connection) => {
    const timestamp = Date.now();
    await connection.query(
      'INSERT INTO rooms (id, name, creator_id, current_epoch, rotation_required, created_at) VALUES (?, ?, ?, 0, FALSE, ?)',
      [id, name.trim(), creatorId, timestamp]
    );
    await connection.query(
      `INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)`,
      [id, creatorId, timestamp]
    );
    for (const userId of new Set(memberIds.filter((memberId) => memberId !== creatorId))) {
      await connection.query(
        `INSERT INTO room_pending_members (room_id, user_id, invited_by_device_id, created_at)
         VALUES (?, ?, ?, ?)`, [id, userId, creatorDeviceId, timestamp]
      );
    }
    await connection.query(
      'INSERT INTO mls_conversations (room_id, conversation_id, created_at) VALUES (?, ?, ?)',
      [id, conversationId, timestamp]
    );
    return { id, name: name.trim(), conversationId };
  });
}

export async function findMlsRoomById(roomId) {
  const room = await first(
    `SELECT r.id, r.name, r.creator_id AS creatorId, r.current_epoch AS currentEpoch,
            mc.conversation_id AS conversationId
     FROM rooms r JOIN mls_conversations mc ON mc.room_id = r.id WHERE r.id = ?`, [roomId]
  );
  return room || null;
}

export function findMlsRoomByConversation(conversationId) {
  return first(
    `SELECT r.id, r.name, r.creator_id AS creatorId, r.current_epoch AS currentEpoch,
            mc.conversation_id AS conversationId
     FROM mls_conversations mc JOIN rooms r ON r.id = mc.room_id
     WHERE mc.conversation_id = ?`, [conversationId]
  );
}

export async function addMlsRoomMembers(roomId, userIds, invitingDeviceId) {
  for (const userId of userIds) {
    await pool.query(
      `INSERT IGNORE INTO room_pending_members
       (room_id, user_id, invited_by_device_id, created_at) VALUES (?, ?, ?, ?)`,
      [roomId, userId, invitingDeviceId, Date.now()]
    );
  }
}

export async function getMlsPendingMemberIds(roomId) {
  const result = await rows(
    'SELECT user_id AS userId FROM room_pending_members WHERE room_id = ?', [roomId]
  );
  return result.map((row) => row.userId);
}

export function finalizeMlsPendingMembers(roomId, userIds) {
  return withTransaction(async (connection) => {
    const timestamp = Date.now();
    for (const userId of new Set(userIds)) {
      const pending = await first(
        `SELECT user_id AS userId FROM room_pending_members
         WHERE room_id = ? AND user_id = ? FOR UPDATE`, [roomId, userId], connection
      );
      if (!pending) continue;
      await connection.query(
        `INSERT IGNORE INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)`,
        [roomId, userId, timestamp]
      );
      await connection.query(
        'DELETE FROM room_pending_members WHERE room_id = ? AND user_id = ?', [roomId, userId]
      );
    }
  });
}

export function insertMlsEnvelope(envelope, recipientMlsDeviceIds = []) {
  return withTransaction(async (connection) => {
    if (envelope.kind === 'Commit') {
      const existing = await first(
        `SELECT id FROM mls_envelopes
         WHERE conversation_id = ? AND epoch = ? AND kind = 'Commit' FOR UPDATE`,
        [envelope.conversationId, envelope.epoch], connection
      );
      if (existing) return null;
    }
    const [result] = await connection.query(
      `INSERT INTO mls_envelopes
       (conversation_id, version, epoch, kind, sender_mls_device_id, sequence_number,
        wall_time, logical_time, payload, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        envelope.conversationId, envelope.version, envelope.epoch, envelope.kind,
        envelope.senderMlsDeviceId, envelope.sequence, envelope.wallTime,
        envelope.logicalTime, envelope.payload, envelope.contentHash, Date.now(),
      ]
    );
    for (const recipient of recipientMlsDeviceIds) {
      await connection.query(
        `INSERT IGNORE INTO mls_envelope_recipients (envelope_id, mls_device_id)
         VALUES (?, ?)`, [result.insertId, recipient]
      );
    }
    if (envelope.kind === 'Commit') {
      await connection.query(
        `UPDATE rooms r JOIN mls_conversations mc ON mc.room_id = r.id
         SET r.current_epoch = GREATEST(r.current_epoch, ?) WHERE mc.conversation_id = ?`,
        [envelope.epoch, envelope.conversationId]
      );
    }
    return result.insertId;
  });
}

const MLS_ENVELOPE_SELECT = `
  SELECT e.id, e.version, e.conversation_id AS conversationId, e.epoch, e.kind,
         e.sender_mls_device_id AS senderMlsDeviceId, e.sequence_number AS sequenceNumber,
         e.wall_time AS wallTime, e.logical_time AS logicalTime, e.payload, e.content_hash AS contentHash
  FROM mls_envelopes e`;

export function listMlsEnvelopes(
  conversationId,
  cursor = { epoch: 0, lastSequencePerDevice: new Map() },
  limit = 500
) {
  const entries = [...cursor.lastSequencePerDevice.values()];
  const params = [conversationId, cursor.epoch];
  let sameEpoch = 'TRUE';
  if (entries.length) {
    const placeholders = entries.map(() => '?').join(', ');
    sameEpoch = `(e.sender_mls_device_id NOT IN (${placeholders})`;
    params.push(...entries.map((entry) => entry.deviceId));
    for (const entry of entries) {
      sameEpoch += ' OR (e.sender_mls_device_id = ? AND e.sequence_number > ?)';
      params.push(entry.deviceId, entry.sequence);
    }
    sameEpoch += ')';
  }
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
  return rows(
    `${MLS_ENVELOPE_SELECT}
     WHERE e.conversation_id = ?
       AND (e.epoch > ? OR (e.epoch = ? AND ${sameEpoch}))
     ORDER BY e.id LIMIT ?`,
    [params[0], params[1], params[1], ...params.slice(2)]
  );
}

export function listPendingMlsWelcomes(deviceId) {
  return rows(
    `${MLS_ENVELOPE_SELECT}
     JOIN mls_envelope_recipients er ON er.envelope_id = e.id
     JOIN mls_device_profiles dp ON dp.mls_device_id = er.mls_device_id
     WHERE dp.device_id = ? AND er.acknowledged_at IS NULL AND e.kind = 'Welcome'
     ORDER BY e.id`, [deviceId]
  );
}

export async function acknowledgeMlsWelcome(envelopeId, deviceId) {
  const [result] = await pool.query(
    `UPDATE mls_envelope_recipients er
     JOIN mls_device_profiles dp ON dp.mls_device_id = er.mls_device_id
     SET er.acknowledged_at = ? WHERE er.envelope_id = ? AND dp.device_id = ?`,
    [Date.now(), envelopeId, deviceId]
  );
  return result.affectedRows > 0;
}

export function findMlsDeviceByServerDevice(deviceId) {
  return first(
    `SELECT dp.mls_device_id AS mlsDeviceId, up.mls_user_id AS mlsUserId
     FROM user_devices d
     JOIN mls_device_profiles dp ON dp.device_id = d.id
     JOIN mls_user_profiles up ON up.user_id = d.user_id
     WHERE d.id = ?`, [deviceId]
  );
}

export function findServerUsersForMlsDevices(mlsDeviceIds) {
  if (!mlsDeviceIds.length) return [];
  return rows(
    `SELECT d.user_id AS userId, dp.mls_device_id AS mlsDeviceId FROM mls_device_profiles dp
     JOIN user_devices d ON d.id = dp.device_id AND d.status = 'active'
     WHERE dp.mls_device_id IN (?)`, [mlsDeviceIds]
  );
}

export async function addMlsMessageRead(messageId, roomId, userId, username, readAt) {
  await pool.query(
    `INSERT IGNORE INTO mls_message_reads (message_id, room_id, user_id, username, read_at)
     VALUES (?, ?, ?, ?, ?)`, [messageId, roomId, userId, username, readAt]
  );
}

export function getMlsMessageReads(messageId) {
  return rows(
    `SELECT user_id AS userId, username, read_at AS readAt
     FROM mls_message_reads WHERE message_id = ?`, [messageId]
  );
}

export default pool;
