import { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { inviteRoomMembers } from '../devices';

export default function InviteMembersModal({ roomId, members, onClose, onInvited }) {
  const [users, setUsers] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const memberIds = new Set(members.map((member) => member.id));
    apiFetch('/users')
      .then((items) => setUsers(items.filter((user) => !memberIds.has(user.id))))
      .catch((loadError) => setError(loadError.message));
  }, [members]);

  function toggleUser(userId) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId); else next.add(userId);
      return next;
    });
  }

  async function submit(event) {
    event.preventDefault();
    const invitedUsers = users.filter((user) => selected.has(user.id));
    if (!invitedUsers.length) return;
    setLoading(true);
    setError('');
    try {
      await inviteRoomMembers(roomId, invitedUsers);
      onInvited();
    } catch (inviteError) {
      setError(inviteError.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <h2>Zaproś do pokoju</h2>
        <p className="modal-desc">Zaproszeni otrzymają dostęp do zaszyfrowanej historii pokoju.</p>
        <form onSubmit={submit}>
          {users.length > 0 ? <fieldset className="member-picker invite-picker">
            <legend>Użytkownicy</legend>
            {users.map((user) => <label key={user.id}>
              <input
                type="checkbox" checked={selected.has(user.id)}
                onChange={() => toggleUser(user.id)} disabled={user.devices.length === 0}
              />
              <span>{user.username}</span>
              <small>{user.devices.length} urz.</small>
            </label>)}
          </fieldset> : <p className="empty-invite-list">Wszyscy użytkownicy są już w pokoju.</p>}
          {error && <p className="error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>Anuluj</button>
            <button type="submit" disabled={loading || selected.size === 0}>
              {loading ? 'Zapraszanie...' : 'Zaproś'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
