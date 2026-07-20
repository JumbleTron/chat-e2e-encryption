import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import {
  approveDeviceLink, createRecoveryBackup, listDevices, listLinkRequests,
  repairPendingRotations, revokeDevice,
} from '../devices';

export default function DevicesModal({ currentDeviceId, onClose, onKeysRotated }) {
  const [devices, setDevices] = useState([]);
  const [requests, setRequests] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [pendingRotations, setPendingRotations] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const [nextDevices, nextRequests, rooms] = await Promise.all([
        listDevices(), listLinkRequests(), apiFetch('/rooms'),
      ]);
      setDevices(nextDevices);
      setRequests(nextRequests);
      setPendingRotations(rooms.filter((room) => room.rotationRequired).length);
    } catch (loadError) {
      setError(loadError.message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [refresh]);

  async function approve(request) {
    setBusyId(request.id);
    setError('');
    try {
      await approveDeviceLink(request);
      await refresh();
    } catch (approveError) {
      setError(approveError.message);
    } finally {
      setBusyId(null);
    }
  }

  async function revoke(device) {
    if (!window.confirm(`Usunąć dostęp urządzenia „${device.name}”? MLS utworzy nowe epoki pokojów.`)) return;
    setBusyId(device.id);
    setError('');
    try {
      await revokeDevice(device.id);
      await refresh();
      onKeysRotated();
    } catch (revokeError) {
      setError(revokeError.message);
    } finally {
      setBusyId(null);
    }
  }

  async function createBackup() {
    setBusyId('backup');
    setError('');
    try {
      setRecoveryCode(await createRecoveryBackup());
    } catch (backupError) {
      setError(backupError.message);
    } finally {
      setBusyId(null);
    }
  }

  async function repairRotations() {
    setBusyId('rotation');
    setError('');
    try {
      await repairPendingRotations();
      await refresh();
      onKeysRotated();
    } catch (rotationError) {
      setError(rotationError.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal devices-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-heading">
          <div><h2>Urządzenia</h2><p className="modal-desc">Aktywne sesje i oczekujące połączenia</p></div>
          <button className="icon-button" onClick={onClose} title="Zamknij" aria-label="Zamknij">×</button>
        </div>

        {requests.length > 0 && <section className="device-section">
          <h3>Do zatwierdzenia</h3>
          {requests.map((request) => <div className="device-row pending" key={request.id}>
            <div><strong>{request.deviceName}</strong><span>Kod: {request.verificationCode}</span></div>
            <button onClick={() => approve(request)} disabled={busyId === request.id}>Zatwierdź</button>
          </div>)}
        </section>}

        {pendingRotations > 0 && <section className="device-section rotation-warning">
          <h3>Wymagana zmiana kluczy</h3>
          <p>{pendingRotations} pokój/pokoje oczekują na bezpieczną rotację.</p>
          <button onClick={repairRotations} disabled={busyId === 'rotation'}>Dokończ rotację</button>
        </section>}

        <section className="device-section">
          <h3>Aktywne urządzenia</h3>
          {devices.filter((device) => device.status === 'active').map((device) => <div className="device-row" key={device.id}>
            <div><strong>{device.name}</strong><span>{device.id === currentDeviceId ? 'To urządzenie' : 'Połączone'}</span></div>
            {device.id !== currentDeviceId && <button className="danger-button" onClick={() => revoke(device)} disabled={busyId === device.id}>Usuń</button>}
          </div>)}
        </section>
        <section className="device-section recovery-section">
          <h3>Odzyskiwanie</h3>
          {recoveryCode ? <div className="recovery-code">
            <span>Kod odzyskiwania</span>
            <code>{recoveryCode}</code>
            <p>Przechowuj go poza aplikacją. Nie będzie ponownie wyświetlony.</p>
          </div> : <button className="backup-button" onClick={createBackup} disabled={busyId === 'backup'}>
            Utwórz kopię tożsamości konta
          </button>}
        </section>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
