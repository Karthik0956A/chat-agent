import React, { useState, useEffect } from 'react';
import Auth from './pages/Auth';
import Chat from './pages/Chat';
import { getToken } from './services/api';

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(!!getToken());

  useEffect(() => {
    const handleUnauth = () => setIsAuthenticated(false);
    window.addEventListener('auth:unauthorized', handleUnauth);
    return () => window.removeEventListener('auth:unauthorized', handleUnauth);
  }, []);

  return isAuthenticated ? (
    <Chat onLogout={() => setIsAuthenticated(false)} />
  ) : (
    <Auth onAuth={() => setIsAuthenticated(true)} />
  );
}
