'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import AwsForm from '../components/AwsForm';
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
  const [viewMode, setViewMode] = useState<'admin' | 'student'>('student');

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
          setViewMode(isAdmin ? 'admin' : 'student');
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

  const handleLogout = async () => {
    try {
      await fetch('/api/logout', { method: 'POST' });
    } catch {}
    setUser(null);
  };

  const handleLoginSuccess = (loggedInUser: UserSession) => {
    setUser(loggedInUser);
    setViewMode(loggedInUser.isAdmin ? 'admin' : 'student');
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="flex items-center gap-3 text-sm text-gray-600 bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
          <svg className="animate-spin h-5 w-5 text-blue-600" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span>Loading SoftMania FreeLabs...</span>
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

  // 2. Authenticated as Admin (or Admin Mode Preview)
  if (user.isAdmin && viewMode === 'admin') {
    return (
      <div className="min-h-screen bg-gray-50 py-8 px-4">
        <div className="max-w-xl mx-auto mb-4 bg-purple-50 border border-purple-200 rounded-xl p-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-purple-900">👑 Admin Portal</span>
            <span className="text-xs text-purple-700">({user.email})</span>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/admin"
              className="text-xs font-semibold px-2.5 py-1 bg-purple-100 text-purple-800 rounded-lg hover:bg-purple-200 border border-purple-300 shadow-sm"
            >
              👑 Open /admin
            </Link>
            <button
              type="button"
              onClick={() => setViewMode('student')}
              className="text-xs font-semibold px-2.5 py-1 bg-white text-purple-700 rounded-lg hover:bg-purple-100 border border-purple-200 shadow-sm"
            >
              👁️ Preview Student View
            </button>
            <button
              type="button"
              onClick={handleLogout}
              className="text-xs text-red-600 hover:text-red-700 font-semibold px-2 py-1"
            >
              Logout
            </button>
          </div>
        </div>

        <div style={{ maxWidth: 600, margin: '0 auto' }}>
          <AwsForm />
        </div>
      </div>
    );
  }

  // 3. Authenticated as Student (Progressive 36-vCPU Quota Verification)
  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 py-10 px-4">
      <StudentPortal
        user={user}
        onLogout={handleLogout}
        onSwitchToAdmin={user.isAdmin ? () => setViewMode('admin') : undefined}
      />
    </div>
  );
}
