'use client';

import { useEffect, useRef, useState } from 'react';

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

function loadGoogleIdentityScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('Browser only'));
  if ((window as unknown as { google?: { accounts?: { id?: unknown } } }).google?.accounts?.id) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[src="https://accounts.google.com/gsi/client"]');
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Google Sign-In failed to load')), {
        once: true,
      });
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Google Sign-In failed to load'));
    document.head.appendChild(script);
  });
}

type Props = {
  onLoginSuccess: (user: { email: string; name: string; isAdmin: boolean; token?: string }) => void;
};

export default function GoogleSignInCard({ onLoginSuccess }: Props) {
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const googleBtnContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;

    loadGoogleIdentityScript()
      .then(() => {
        if (!active) return;
        const googleObj = (window as unknown as { google?: { accounts?: { id?: any } } }).google;
        if (!googleObj?.accounts?.id || !GOOGLE_CLIENT_ID) {
          console.warn('Google Identity Client ID not found');
          return;
        }

        googleObj.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: async (res: { credential?: string }) => {
            const idToken = res.credential;
            if (!idToken) return;

            setLoading(true);
            setErrorMessage('');

            try {
              // 1. Authenticate with Google
              const authRes = await fetch('/api/auth/google-auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: idToken }),
              });
              const authData = await authRes.json();

              if (!authRes.ok || !authData.success) {
                throw new Error(authData?.message || 'Google authentication failed');
              }

              const tokenToUse = (authData.access_token || authData.token || authData.id_token || idToken) as string;

              let decodedEmail = '';
              let decodedName = '';
              if (tokenToUse) {
                try {
                  const parts = tokenToUse.split('.');
                  if (parts.length >= 2) {
                    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
                    const payload = JSON.parse(atob(base64));
                    decodedEmail = payload.email || payload.email_id || '';
                    decodedName = payload.name || payload.given_name || '';
                  }
                } catch {}
              }

              const userEmail =
                authData.user?.email ||
                authData.user?.email_id ||
                decodedEmail ||
                '';
              const userName =
                authData.user?.name ||
                authData.user?.first_name ||
                decodedName ||
                userEmail.split('@')[0] ||
                '';

              // 2. Check if user is an Admin via /api/auth/verify-admin
              let isAdmin = false;
              try {
                const adminRes = await fetch('/api/auth/verify-admin', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    ...(tokenToUse ? { Authorization: `Bearer ${tokenToUse}` } : {}),
                  },
                  body: JSON.stringify({ token: tokenToUse }),
                });
                const adminData = await adminRes.json();
                isAdmin = Boolean(adminData?.is_admin === true);
              } catch (err) {
                console.warn('[AUTH] Verify admin check failed:', err);
              }

              onLoginSuccess({
                email: userEmail,
                name: userName,
                isAdmin,
                token: tokenToUse,
              });
            } catch (err: any) {
              console.error('[LOGIN] Error during authentication:', err);
              setErrorMessage(err?.message || 'Sign in failed. Please try again.');
            } finally {
              setLoading(false);
            }
          },
        });

        if (googleBtnContainerRef.current) {
          googleBtnContainerRef.current.innerHTML = '';
          googleObj.accounts.id.renderButton(googleBtnContainerRef.current, {
            theme: 'outline',
            size: 'large',
            text: 'continue_with',
            shape: 'rectangular',
            width: 300,
          });
        }
      })
      .catch((err) => {
        console.error('[GOOGLE-INIT] Error loading script:', err);
        setErrorMessage('Could not load Google Sign-In. Please check your network connection.');
      });

    return () => {
      active = false;
    };
  }, [onLoginSuccess]);

  return (
    <div className="mx-auto max-w-md bg-white rounded-2xl shadow-xl p-8 border border-gray-100 text-center">
      {/* Brand Header */}
      <div className="mb-6">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-500 text-white shadow-lg mb-4">
          <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
        </div>
        <h1 className="text-2xl font-extrabold text-gray-900 tracking-tight">Soft Mania AWS Labs</h1>
        <p className="text-sm text-gray-500 mt-1">Sign in with your Google account to get started</p>
      </div>

      {/* Error Notice */}
      {errorMessage && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg text-left">
          {errorMessage}
        </div>
      )}

      {/* Loading state or Google button container */}
      <div className="flex flex-col items-center justify-center min-h-[50px]">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <svg className="animate-spin h-5 w-5 text-blue-600" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span>Verifying your account...</span>
          </div>
        ) : (
          <div ref={googleBtnContainerRef} className="flex justify-center" />
        )}
      </div>

      <div className="mt-6 pt-4 border-t border-gray-100 text-xs text-gray-400">
        Secured by Soft Mania
      </div>
    </div>
  );
}
