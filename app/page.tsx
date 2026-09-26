'use client';

import { useState, useEffect } from 'react';
import StudentPortal from '../components/StudentPortal';
import GoogleSignInCard from '../components/GoogleSignInCard';

type UserSession = {
  email: string;
  name: string;
  isAdmin: boolean;
  token?: string;
};

export default function HomePage() {
  const [user, setUser] = useState<UserSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    // Check existing profile on mount
    fetch('/api/auth/profile')
      .then((res) => res.json())
      .then(async (data) => {
        if (!active) return;

        if (data.authenticated && data.user) {
          const email = data.user?.email || data.user?.email_id || '';
          const name = data.user?.name || data.user?.first_name || email.split('@')[0] || 'User';
          const token = data.token || undefined;

          // Verify if admin via /api/auth/verify-admin
          let isAdmin = false;
          try {
            const adminRes = await fetch('/api/auth/verify-admin', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
              body: JSON.stringify({ token }),
            });
            const adminData = await adminRes.json();
            isAdmin = Boolean(adminData?.is_admin === true);
          } catch (err) {
            console.warn('[AUTH] Verify admin check failed:', err);
          }

          const session: UserSession = { email, name, isAdmin, token };
          setUser(session);
        }
      })
      .catch((err) => {
        console.warn('[AUTH] Profile fetch failed:', err);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  // Background token refresh timer every 10 minutes to prevent token expiration
  useEffect(() => {
    if (!user) return;

    const refreshInterval = setInterval(async () => {
      try {
        const res = await fetch('/api/auth/refresh', { method: 'POST' });
        const data = await res.json();
        if (data.success && data.token) {
          setUser((prev) => (prev ? { ...prev, token: data.token } : null));
        }
      } catch (err) {
        console.warn('[AUTH] Background token refresh error:', err);
      }
    }, 10 * 60 * 1000);

    return () => clearInterval(refreshInterval);
  }, [user?.email]);

  const handleLogout = async () => {
    try {
      await fetch('/api/logout', { method: 'POST' });
    } catch {}
    setUser(null);
  };

  const handleLoginSuccess = (loggedInUser: UserSession) => {
    setUser(loggedInUser);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="flex items-center gap-3 text-sm text-gray-600 bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
          <svg className="animate-spin h-5 w-5 text-blue-600" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span>Loading Soft Mania AWS Labs...</span>
        </div>
      </div>
    );
  }

  // 1. Unauthenticated: Show ONLY Google Sign-In Card
  if (!user) {
    return (
      <div className="min-h-screen flex flex-col justify-center items-center bg-gradient-to-b from-gray-50 to-gray-100 p-4">
        <GoogleSignInCard onLoginSuccess={handleLoginSuccess} />
      </div>
    );
  }

  // 2. Authenticated: Always render Student Portal at '/'
  // (Admins can access Admin Console via the '👑 Admin Console' header button linking to /admin)
  return (
    <StudentPortal
      user={user}
      onLogout={handleLogout}
    />
  );
}
