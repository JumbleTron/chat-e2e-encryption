import { useEffect, useRef, useState } from 'react';
import { registerUser } from '../hooks/useChat';
import {
  beginDeviceLink, browserDeviceName, finishDeviceLink, restoreFromRecovery,
} from '../devices';

export default function LoginScreen({ onLogin }) {
  const [mode, setMode] = useState('register');
  const [username, setUsername] = useState('');
  const [deviceName, setDeviceName] = useState(browserDeviceName());
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [link, setLink] = useState(null);
  const [recoveryCode, setRecoveryCode] = useState('');
  const pollingRef = useRef(null);

  useEffect(() => () => clearInterval(pollingRef.current), []);

  async function handleSubmit(event) {
    event.preventDefault();
    if (!username.trim() || !deviceName.trim()) return;
    setLoading(true);
    setError('');
    try {
      if (mode === 'register') {
        onLogin(await registerUser(username.trim(), deviceName.trim()));
      } else if (mode === 'link') {
        const pending = await beginDeviceLink(username.trim(), deviceName.trim());
        setLink(pending);
        pollingRef.current = setInterval(async () => {
          try {
            const session = await finishDeviceLink(pending);
            if (session) {
              clearInterval(pollingRef.current);
              onLogin(session);
            }
          } catch (pollError) {
            clearInterval(pollingRef.current);
            setError(pollError.message);
          }
        }, 1500);
      } else {
        onLogin(await restoreFromRecovery(username.trim(), recoveryCode.trim(), deviceName.trim()));
      }
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setLoading(false);
    }
  }

  function changeMode(nextMode) {
    clearInterval(pollingRef.current);
    setLink(null);
    setError('');
    setMode(nextMode);
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="lock-icon" aria-hidden="true">E2E</div>
        <h1>Secure Group Chat</h1>
        <p className="subtitle">Forward secrecy i członkostwo urządzeń przez MLS</p>

        <div className="mode-tabs" role="tablist">
          <button className={mode === 'register' ? 'active' : ''} onClick={() => changeMode('register')}>
            Nowe konto
          </button>
          <button className={mode === 'link' ? 'active' : ''} onClick={() => changeMode('link')}>
            Połącz urządzenie
          </button>
          <button className={mode === 'recover' ? 'active' : ''} onClick={() => changeMode('recover')}>
            Odzyskaj
          </button>
        </div>

        {link ? (
          <div className="link-code-panel">
            <span>Kod weryfikacyjny</span>
            <strong>{link.verificationCode}</strong>
            <p>Zatwierdź ten kod na urządzeniu, na którym konto jest już aktywne.</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <input
              type="text" placeholder="Nazwa użytkownika" value={username}
              onChange={(event) => setUsername(event.target.value)} maxLength={32} autoFocus
            />
            <input
              type="text" placeholder="Nazwa urządzenia" value={deviceName}
              onChange={(event) => setDeviceName(event.target.value)} maxLength={64}
            />
            {mode === 'recover' && <textarea
              className="recovery-input" placeholder="Kod odzyskiwania"
              value={recoveryCode} onChange={(event) => setRecoveryCode(event.target.value)}
              rows={3}
            />}
            {error && <p className="error">{error}</p>}
            <button type="submit" disabled={loading || !username.trim() || !deviceName.trim() || (mode === 'recover' && !recoveryCode.trim())}>
              {loading ? 'Przetwarzanie...' : mode === 'register'
                ? 'Utwórz konto' : mode === 'link' ? 'Wygeneruj kod' : 'Odzyskaj konto'}
            </button>
          </form>
        )}
        {link && error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
