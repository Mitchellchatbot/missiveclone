import React, { useState } from 'react';
import { api } from '../api';
import ConnectAccount from './ConnectAccount.jsx';

export default function OnboardingScreen({ me, teamSpaces, onDone, onSkip }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [showImap, setShowImap] = useState(false);

  async function connectMicrosoft() {
    setBusy(true); setErr('');
    try {
      const r = await api('/api/oauth/microsoft/start');
      if (r && r.url) {
        window.location.href = r.url;
      } else {
        setErr('OAuth start did not return a URL.');
        setBusy(false);
      }
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="onboarding-wrap">
      <div className="onboarding-card">
        <div className="onboarding-eyebrow">Welcome to {me.workspace?.name || 'your workspace'}</div>
        <h1>Let's connect your inbox.</h1>
        <p className="muted">
          Hi {me.user?.name?.split(' ')[0] || 'there'} 👋 — to start collaborating on email,
          connect a mailbox. Your team will see incoming mail in the shared inbox; replies
          go out from the mailbox you connect, not from you personally.
        </p>

        <button className="ms-btn-large" onClick={connectMicrosoft} disabled={busy}>
          <svg width="20" height="20" viewBox="0 0 23 23" style={{ marginRight: 10, verticalAlign: 'middle' }}>
            <rect x="1" y="1" width="10" height="10" fill="#f25022"/>
            <rect x="12" y="1" width="10" height="10" fill="#7fba00"/>
            <rect x="1" y="12" width="10" height="10" fill="#00a4ef"/>
            <rect x="12" y="12" width="10" height="10" fill="#ffb900"/>
          </svg>
          {busy ? 'Redirecting to Microsoft…' : 'Sign in with Microsoft'}
        </button>

        <div className="onboarding-divider"><span>or</span></div>

        <button className="ghost wide" onClick={() => setShowImap(true)}>
          Connect with IMAP / SMTP (Gmail, Yahoo, custom)
        </button>

        <div className="onboarding-skip">
          <button className="link" onClick={onSkip}>I'll connect a mailbox later →</button>
        </div>

        {err && <div className="err">{err}</div>}

        <div className="onboarding-foot">
          <div className="muted small">
            <strong>Tip:</strong> Don't have a shared address like <code>tech@scaledai.org</code>?
            Create one as a <a href="https://admin.microsoft.com/Adminportal/Home?#/groups" target="_blank" rel="noreferrer">free shared mailbox</a> in
            Microsoft 365 admin, then connect it here.
          </div>
        </div>
      </div>

      {showImap && (
        <ConnectAccount
          teamSpaces={teamSpaces}
          defaultTeamSpaceId={teamSpaces[0]?.id}
          onClose={() => setShowImap(false)}
          onCreated={() => { setShowImap(false); onDone && onDone(); }}
        />
      )}
    </div>
  );
}
