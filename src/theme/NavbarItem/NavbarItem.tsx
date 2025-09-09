import React, { useEffect, useState } from 'react';
import { auth } from '../../firebase';
import { onAuthStateChanged, signOut, User } from 'firebase/auth';
import OriginalNavbarItem from '@theme-original/NavbarItem';

export default function NavbarItem(props: any) {
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
      <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
        <span>{user.email}</span>
        <button onClick={handleLogout}>登出</button>
      </div>
    );
  }

  // 未登录显示登录/注册
  return (
    <div>
      <a href="/login" style={{ marginRight: 10 }}>登录</a>
      <a href="/register">注册</a>
    </div>
  );
}

