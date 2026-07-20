import { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import {
  generateGroupKey, exportGroupKey, saveRoomGroupKey,
} from '../crypto';
import { createRoom } from '../hooks/useChat';

export default function CreateRoomModal({ user, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [allUsers, setAllUsers] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch('/users')
      .then(setAllUsers)
      .catch((loadError) => setError(loadError.message));
  }, [user.id]);

  function toggleUser(userId) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId); else next.add(userId);
      return next;
    });
  }

  async function handleCreate(event) {
    event.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    setError('');
    try {
      const groupKey = await generateGroupKey();
      const groupKeyBase64 = await exportGroupKey(groupKey);
      const currentUser = allUsers.find((item) => item.id === user.id) || {
        id: user.id,
        devices: [{ id: user.deviceId, publicKey: user.publicKey }],
      };
      const members = [currentUser, ...allUsers.filter((item) => item.id !== user.id && selected.has(item.id))];
      const room = await createRoom(name.trim(), members, groupKeyBase64);
      saveRoomGroupKey(room.id, groupKeyBase64, 1);
      onCreated(room.id, groupKey);
    } catch (createError) {
      setError(createError.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <h2>Nowy pokój czatu</h2>
        <p className="modal-desc">Klucz zostanie zaszyfrowany osobno dla każdego urządzenia członków.</p>
        <form onSubmit={handleCreate}>
          <input
            type="text" placeholder="Nazwa pokoju" value={name}
            onChange={(event) => setName(event.target.value)} maxLength={64} autoFocus
          />
          {allUsers.some((item) => item.id !== user.id) && <fieldset className="member-picker">
            <legend>Uczestnicy</legend>
            {allUsers.filter((item) => item.id !== user.id).map((item) => <label key={item.id}>
              <input
                type="checkbox" checked={selected.has(item.id)}
                onChange={() => toggleUser(item.id)}
                disabled={item.devices.length === 0}
              />
              <span>{item.username}</span>
              <small>{item.devices.length} urz.</small>
            </label>)}
          </fieldset>}
          {error && <p className="error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>Anuluj</button>
            <button type="submit" disabled={loading || !name.trim()}>
              {loading ? 'Tworzenie...' : 'Utwórz pokój'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
