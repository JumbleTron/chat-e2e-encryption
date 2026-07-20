-- MySQL 8.x reference schema. The backend applies equivalent idempotent DDL at startup.
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(36) PRIMARY KEY,
  username VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  created_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS rooms (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(64) NOT NULL,
  creator_id VARCHAR(36) NOT NULL,
  current_epoch INT NOT NULL DEFAULT 1,
  rotation_required BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  CONSTRAINT fk_rooms_creator FOREIGN KEY (creator_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS user_devices (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS room_members (
  room_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  encrypted_group_key LONGTEXT NULL,
  joined_at BIGINT NOT NULL,
  PRIMARY KEY (room_id, user_id),
  INDEX idx_room_members_user (user_id),
  CONSTRAINT fk_room_members_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_room_members_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS device_link_requests (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  device_id VARCHAR(36) NOT NULL UNIQUE,
  verification_code CHAR(6) NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  CONSTRAINT fk_link_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_link_device FOREIGN KEY (device_id) REFERENCES user_devices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS room_device_keys (
  room_id VARCHAR(36) NOT NULL,
  device_id VARCHAR(36) NOT NULL,
  key_epoch INT NOT NULL DEFAULT 1,
  encrypted_group_key LONGTEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (room_id, device_id, key_epoch),
  INDEX idx_room_device_keys_device (device_id, room_id),
  CONSTRAINT fk_room_keys_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_room_keys_device FOREIGN KEY (device_id) REFERENCES user_devices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS messages (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS message_reads (
  message_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  username VARCHAR(32) NOT NULL,
  read_at BIGINT NOT NULL,
  PRIMARY KEY (message_id, user_id),
  CONSTRAINT fk_reads_message FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  CONSTRAINT fk_reads_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS recovery_backups (
  user_id VARCHAR(36) PRIMARY KEY,
  ciphertext LONGTEXT NOT NULL,
  iv TEXT NOT NULL,
  recovery_auth_hash CHAR(64) NOT NULL,
  updated_at BIGINT NOT NULL,
  CONSTRAINT fk_recovery_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
