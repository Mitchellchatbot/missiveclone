import React, { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login.jsx';
import Signup from './pages/Signup.jsx';
import Dashboard from './pages/Dashboard.jsx';
import AcceptInvite from './pages/AcceptInvite.jsx';
import { api, getToken, setToken } from './api';

export default function App() {
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) { setLoading(false); return; }
    api('/api/auth/me')
      .then(setMe)
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="center">Loading…</div>;

  return (
    <Routes>
      <Route path="/login" element={me ? <Navigate to="/" /> : <Login onAuth={setMe} />} />
      <Route path="/signup" element={me ? <Navigate to="/" /> : <Signup onAuth={setMe} />} />
      <Route path="/invite/:token" element={<AcceptInvite onAuth={setMe} />} />
      <Route path="/*" element={me ? <Dashboard me={me} onLogout={() => { setToken(null); setMe(null); }} /> : <Navigate to="/login" />} />
    </Routes>
  );
}
