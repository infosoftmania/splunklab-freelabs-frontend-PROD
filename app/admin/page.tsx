'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import AwsForm from '../../components/AwsForm';
import GoogleSignInCard from '../../components/GoogleSignInCard';

type UserSession = {
  email: string;
  name: string;
  isAdmin: boolean;
};

export default function AdminPage() {
  const [user, setUser] = useState<UserSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    fetch('/api/auth/profile')
      .then((res) => res.json())
      .then(async (data) => {
        if (!active) return;

        if (data.authenticated && data.user) {
          const email = data.user?.email || data.user?.email_id || '';
          const name = data.user?.name || data.user?.first_name || email.split('@')[0] || 'Admin';
          const token = data.token || '';

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
            console.warn('[ADMIN] Verify admin check failed:', err);
          }

          const session: UserSession = { email, name, isAdmin };
          setUser(session);
        }
      })
      .catch((err) => {
        console.warn('[ADMIN] Profile check failed:', err);
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
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="flex items-center gap-3 text-sm text-gray-600 bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
          <svg className="animate-spin h-5 w-5 text-purple-600" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span>Verifying Admin credentials...</span>
        </div>
      </div>
    );
  }

  // 1. Not signed in: Show Google Sign-In with Admin prompt
  if (!user) {
    return (
      <div className="min-h-screen flex flex-col justify-center items-center bg-gradient-to-b from-gray-50 to-gray-100 p-4">
        <div className="mb-4 text-center">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-purple-100 text-purple-800 text-xs font-bold rounded-full uppercase tracking-wider mb-2">
            👑 Admin Access Required
          </span>
          <p className="text-xs text-gray-500">Sign in with an authorized Google account to access the Admin Console.</p>
        </div>
        <GoogleSignInCard onLoginSuccess={handleLoginSuccess} />
      </div>
    );
  }

  // 2. Signed in, but NOT an admin
  if (!user.isAdmin) {
    return (
      <div className="min-h-screen flex flex-col justify-center items-center bg-gradient-to-b from-gray-50 to-gray-100 p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8 border border-red-100 text-center">
          <div className="w-12 h-12 bg-red-100 text-red-600 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-gray-900 mb-2">Access Denied</h1>
          <p className="text-sm text-gray-600 mb-1">
            Logged in as: <strong className="text-gray-800">{user.email}</strong>
          </p>
          <p className="text-xs text-red-600 bg-red-50 p-3 rounded-xl border border-red-200 mb-6">
            ❌ This Google account does not have Administrator privileges in the DynamoDB Admin table.
          </p>
          <div className="flex flex-col gap-2">
            <Link
              href="/"
              className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-xl transition shadow"
            >
              Go to Student Portal
            </Link>
            <button
              type="button"
              onClick={handleLogout}
              className="w-full py-2 px-4 text-xs text-gray-600 hover:text-gray-900 font-medium"
            >
              Sign out / Switch account
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 3. Authenticated as Admin
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top Bar */}
      <header className="bg-white border-b border-gray-200 shadow-sm sticky top-0 z-30">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="w-8 h-8 bg-purple-600 rounded-lg flex items-center justify-center text-white text-sm">👑</span>
            <div>
              <p className="text-sm font-bold text-gray-900 leading-none">Admin Console</p>
              <p className="text-xs text-gray-500 leading-none mt-0.5">{user.email}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/"
              className="text-xs font-semibold px-3 py-1.5 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 border border-gray-200 transition"
            >
              🎓 Student Portal
            </Link>
            <button
              type="button"
              onClick={handleLogout}
              className="text-xs text-red-600 hover:text-red-700 font-semibold px-3 py-1.5 rounded-lg border border-red-100 hover:bg-red-50 transition"
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      {/* Page Content */}
      <main className="max-w-lg mx-auto px-4 py-8">
        <AwsForm userEmail={user.email} userName={user.name} />
      </main>
    </div>
  );
}
