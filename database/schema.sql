CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(36) PRIMARY KEY,
  username VARCHAR(32) NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  created_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS rooms (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(64) NOT NULL,
  creator_id VARCHAR(36) NOT NULL,
  current_epoch INT NOT NULL DEFAULT 0,
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
  joined_at BIGINT NOT NULL,
  PRIMARY KEY (room_id, user_id),
  INDEX idx_room_members_user (user_id),
  CONSTRAINT fk_room_members_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_room_members_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS room_pending_members (
  room_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  invited_by_device_id VARCHAR(36) NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (room_id, user_id),
  CONSTRAINT fk_pending_member_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_pending_member_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_pending_member_inviter FOREIGN KEY (invited_by_device_id)
    REFERENCES user_devices(id) ON DELETE CASCADE
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

CREATE TABLE IF NOT EXISTS recovery_backups (
  user_id VARCHAR(36) PRIMARY KEY,
  ciphertext LONGTEXT NOT NULL,
  iv TEXT NOT NULL,
  recovery_auth_hash CHAR(64) NOT NULL,
  updated_at BIGINT NOT NULL,
  CONSTRAINT fk_recovery_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS mls_user_profiles (
  user_id VARCHAR(36) PRIMARY KEY,
  mls_user_id VARBINARY(64) NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  CONSTRAINT fk_mls_user_profile FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS mls_device_profiles (
  device_id VARCHAR(36) PRIMARY KEY,
  mls_device_id VARBINARY(64) NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  CONSTRAINT fk_mls_device_profile FOREIGN KEY (device_id) REFERENCES user_devices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS mls_key_packages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  device_id VARCHAR(36) NOT NULL,
  package_hash CHAR(64) NOT NULL UNIQUE,
  key_package LONGBLOB NOT NULL,
  is_last_resort BOOLEAN NOT NULL DEFAULT FALSE,
  claimed_at BIGINT NULL,
  created_at BIGINT NOT NULL,
  INDEX idx_mls_packages_available (device_id, is_last_resort, claimed_at),
  CONSTRAINT fk_mls_package_device FOREIGN KEY (device_id) REFERENCES user_devices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS mls_conversations (
  room_id VARCHAR(36) PRIMARY KEY,
  conversation_id VARBINARY(64) NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  CONSTRAINT fk_mls_conversation_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS mls_envelopes (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS mls_envelope_recipients (
  envelope_id BIGINT UNSIGNED NOT NULL,
  mls_device_id VARBINARY(64) NOT NULL,
  acknowledged_at BIGINT NULL,
  PRIMARY KEY (envelope_id, mls_device_id),
  INDEX idx_mls_welcome_recipient (mls_device_id, acknowledged_at),
  CONSTRAINT fk_mls_recipient_envelope FOREIGN KEY (envelope_id)
    REFERENCES mls_envelopes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS mls_message_reads (
  message_id VARCHAR(36) NOT NULL,
  room_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  username VARCHAR(32) NOT NULL,
  read_at BIGINT NOT NULL,
  PRIMARY KEY (message_id, user_id),
  INDEX idx_mls_reads_room (room_id, message_id),
  CONSTRAINT fk_mls_reads_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_mls_reads_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS mls_device_link_secrets (
  request_id VARCHAR(36) PRIMARY KEY,
  encrypted_identity LONGTEXT NOT NULL,
  approving_device_id VARCHAR(36) NOT NULL,
  created_at BIGINT NOT NULL,
  CONSTRAINT fk_mls_link_request FOREIGN KEY (request_id)
    REFERENCES device_link_requests(id) ON DELETE CASCADE,
  CONSTRAINT fk_mls_link_approver FOREIGN KEY (approving_device_id)
    REFERENCES user_devices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
