import React, { useEffect, useState } from 'react';
import { auth } from '../../firebase';
import { onAuthStateChanged, signOut, User } from 'firebase/auth';

export default function CustomAuthStatus() {
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => setUser(u));
    return () => unsubscribe();
  }, []);

  const handleLogout = async () => {
    await signOut(auth);
    setUser(null);
    window.location.href = '/';
  };

  if (user) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <span>{user.email}</span>
        <button onClick={handleLogout}>登出</button>
      </div>
    );
  }

  return (
    <div>
      <a href="/login" style={{ marginRight: 10 }}>登录</a>
      <a href="/register">注册</a>
    </div>
  );
}

