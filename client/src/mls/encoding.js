export function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function serializeEnvelope(envelope) {
  return {
    version: envelope.v,
    conversationId: bytesToBase64(envelope.conversation_id),
    epoch: envelope.epoch,
    kind: envelope.kind,
    senderDeviceId: bytesToBase64(envelope.sender_device),
    sequence: envelope.seq,
    wallTime: envelope.hlc.wall_ms,
    logicalTime: envelope.hlc.logical,
    payload: bytesToBase64(envelope.payload),
    contentHash: bytesToBase64(envelope.content_hash),
  };
}

export function deserializeEnvelope(value) {
  return {
    v: value.version,
    conversation_id: base64ToBytes(value.conversationId),
    epoch: Number(value.epoch),
    kind: value.kind,
    sender_device: base64ToBytes(value.senderDeviceId),
    seq: Number(value.sequence),
    hlc: { wall_ms: Number(value.wallTime), logical: Number(value.logicalTime) },
    payload: base64ToBytes(value.payload),
    content_hash: base64ToBytes(value.contentHash),
  };
}
