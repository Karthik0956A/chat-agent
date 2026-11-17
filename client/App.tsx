import React, { useState } from 'react';
import Auth from './pages/Auth';
import Chat from './pages/Chat';
import { getToken } from './api';

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(!!getToken());

  return isAuthenticated ? (
    <Chat onLogout={() => setIsAuthenticated(false)} />
  ) : (
    <Auth onAuth={() => setIsAuthenticated(true)} />
  );
}
