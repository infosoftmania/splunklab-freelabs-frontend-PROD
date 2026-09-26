import type { NextRequest } from 'next/server';

export interface AuthenticatedBackendFetchResult {
  response: Response;
  refreshSetCookies: string[];
  refreshed: boolean;
}

export type RequestLike =
  | NextRequest
  | {
      cookies: {
        get(name: string): { value: string } | undefined;
      };
    }
  | {
      get(name: string): { value: string } | undefined;
    };

function getCookieGetter(incomingRequest: RequestLike) {
  if ('cookies' in incomingRequest && incomingRequest.cookies) {
    return incomingRequest.cookies;
  }

  return incomingRequest as {
    get(name: string): { value: string } | undefined;
  };
}

export interface AuthenticatedBackendFetchOptions
  extends Omit<RequestInit, 'headers'> {
  headers?: HeadersInit;
}

type RefreshResult = {
  accessToken: string | null;
  response: Response;
  setCookies: string[];
};

type HeadersWithGetSetCookie = Headers & {
  getSetCookie?: () => string[];
};

const refreshesBySession = new Map<string, Promise<RefreshResult>>();

function getSetCookies(response: Response): string[] {
  const headers = response.headers as HeadersWithGetSetCookie;

  const cookies = headers.getSetCookie?.();

  const result = cookies?.length
    ? cookies
    : (() => {
        const singleCookie = response.headers.get('set-cookie');
        return singleCookie ? [singleCookie] : [];
      })();

  return result.map((cookie) => {
    const cookieName = cookie.split(';')[0]?.split('=')[0]?.trim();

    if (cookieName === 'access_token' || cookieName === 'refresh_token') {
      let normalizedCookie = cookie.replace(/;\s*Path=\/auth\/?/i, '; Path=/');

      if (cookieName === 'access_token') {
        normalizedCookie = normalizedCookie.replace(
          /;\s*Max-Age=\d+/i,
          '; Max-Age=86400',
        );
      }

      return normalizedCookie;
    }

    return cookie;
  });
}

function getCookieValue(setCookies: string[], name: string): string | null {
  for (const setCookie of setCookies) {
    const separator = setCookie.indexOf(';');

    const cookiePair =
      separator === -1 ? setCookie : setCookie.slice(0, separator);

    const equalsIndex = cookiePair.indexOf('=');

    if (equalsIndex === -1) continue;

    const cookieName = cookiePair.slice(0, equalsIndex).trim();
    const value = cookiePair.slice(equalsIndex + 1).trim();

    if (cookieName === name && value) {
      return value;
    }
  }

  return null;
}

function createRequest(
  input: RequestInfo | URL,
  options: AuthenticatedBackendFetchOptions,
): Request {
  const { headers, ...requestInit } = options;

  return new Request(input, {
    ...requestInit,
    headers: new Headers(headers),
  });
}

async function fetchWithAccessToken(
  request: Request,
  accessToken: string | null,
): Promise<Response> {
  const headers = new Headers(request.headers);

  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  } else {
    headers.delete('Authorization');
  }

  return fetch(
    new Request(request.clone(), {
      headers,
    }),
  );
}

async function refreshAccessToken(
  refreshToken: string,
  sessionId: string,
): Promise<RefreshResult> {
  const authUrl = process.env.NEXT_PUBLIC_AUTH_URL?.replace(/\/+$/, '');

  if (!authUrl) {
    return {
      accessToken: null,
      response: new Response(null, {
        status: 500,
        statusText: 'Authentication service is not configured',
      }),
      setCookies: [],
    };
  }

  try {
    const cookieHeader = `refresh_token=${refreshToken}; session_id=${sessionId}`;

    const response = await fetch(`${authUrl}/auth/refresh`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
      },
      body: JSON.stringify({
        refresh_token: refreshToken,
        session_id: sessionId,
      }),
      cache: 'no-store',
    });

    const setCookies = getSetCookies(response);

    if (!response.ok) {
      return {
        accessToken: null,
        response,
        setCookies,
      };
    }

    let accessToken = getCookieValue(setCookies, 'access_token');
    let responseBody: any = null;
    try {
      const responseText = await response.clone().text();
      responseBody = responseText ? JSON.parse(responseText) : null;
    } catch {}

    if (!accessToken && responseBody && typeof responseBody === 'object') {
      accessToken =
        responseBody.access_token ||
        responseBody.token ||
        responseBody.data?.access_token ||
        null;
    }

    if (accessToken && !getCookieValue(setCookies, 'access_token')) {
      setCookies.push(
        `access_token=${accessToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
      );
    }

    const returnedRefreshToken =
      getCookieValue(setCookies, 'refresh_token') || responseBody?.refresh_token;
    if (returnedRefreshToken && !getCookieValue(setCookies, 'refresh_token')) {
      setCookies.push(
        `refresh_token=${returnedRefreshToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
      );
    }

    if (!accessToken) {
      return {
        accessToken: null,
        response: new Response(null, {
          status: 401,
          statusText: 'Refresh did not return an access token',
        }),
        setCookies,
      };
    }

    return {
      accessToken,
      response,
      setCookies,
    };
  } catch {
    return {
      accessToken: null,
      response: new Response(null, {
        status: 502,
        statusText: 'Authentication refresh request failed',
      }),
      setCookies: [],
    };
  }
}

export function decodeJwtPayload(tokenStr: string): Record<string, any> | null {
  try {
    const parts = tokenStr.split('.');
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const jsonStr = Buffer.from(base64, 'base64').toString('utf-8');
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

export function isJwtExpired(token?: string, skewSeconds = 30): boolean {
  if (!token || typeof token !== 'string') return true;
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== 'number') {
    return false;
  }
  const now = Math.floor(Date.now() / 1000);
  return payload.exp <= now + skewSeconds;
}

export function getCoordinatedRefresh(
  refreshToken: string,
  sessionId: string,
): Promise<RefreshResult> {
  const existing = refreshesBySession.get(sessionId);

  if (existing) {
    return existing;
  }

  const refresh = refreshAccessToken(refreshToken, sessionId);

  refreshesBySession.set(sessionId, refresh);

  void refresh.finally(() => {
    if (refreshesBySession.get(sessionId) === refresh) {
      refreshesBySession.delete(sessionId);
    }
  });

  return refresh;
}

export async function getValidAccessToken(
  incomingRequest: RequestLike,
  fallbackToken?: string
): Promise<{ token: string | null; setCookies: string[]; refreshed: boolean }> {
  const cookieGetter = getCookieGetter(incomingRequest);
  const cookieAccessToken = cookieGetter.get('access_token')?.value;
  const cookieGoogleToken = cookieGetter.get('google_token')?.value;
  const candidateToken = cookieAccessToken || fallbackToken || cookieGoogleToken || null;

  // If candidate token is valid and NOT expired, return immediately
  if (candidateToken && !isJwtExpired(candidateToken)) {
    return { token: candidateToken, setCookies: [], refreshed: false };
  }

  // Token is expired or missing: attempt refresh using refresh_token & session_id
  const refreshToken = cookieGetter.get('refresh_token')?.value;
  const sessionId =
    cookieGetter.get('session_id')?.value ||
    cookieGetter.get('session_token')?.value;

  if (refreshToken && sessionId) {
    try {
      const refreshResult = await getCoordinatedRefresh(refreshToken, sessionId);
      if (refreshResult.accessToken) {
        return {
          token: refreshResult.accessToken,
          setCookies: refreshResult.setCookies,
          refreshed: true,
        };
      }
    } catch (refreshErr) {
      console.warn('[AUTH-REFRESH] Auto-refresh failed:', refreshErr);
    }
  }

  return { token: candidateToken, setCookies: [], refreshed: false };
}

export async function authenticatedBackendFetch(
  incomingRequest: RequestLike,
  input: RequestInfo | URL,
  options: AuthenticatedBackendFetchOptions = {},
): Promise<AuthenticatedBackendFetchResult> {
  const requestTemplate = createRequest(input, options);
  const cookieGetter = getCookieGetter(incomingRequest);

  const accessToken = cookieGetter.get('access_token')?.value ?? null;

  const initialResponse = await fetchWithAccessToken(
    requestTemplate,
    accessToken,
  );

  if (initialResponse.status !== 401) {
    return {
      response: initialResponse,
      refreshSetCookies: [],
      refreshed: false,
    };
  }

  const refreshToken = cookieGetter.get('refresh_token')?.value;
  const sessionId = cookieGetter.get('session_id')?.value;

  if (!refreshToken || !sessionId) {
    return {
      response: initialResponse,
      refreshSetCookies: [],
      refreshed: false,
    };
  }

  const refreshResult = await getCoordinatedRefresh(refreshToken, sessionId);

  if (!refreshResult.accessToken) {
    return {
      response: refreshResult.response.clone(),
      refreshSetCookies: refreshResult.setCookies,
      refreshed: false,
    };
  }

  const retryResponse = await fetchWithAccessToken(
    requestTemplate,
    refreshResult.accessToken,
  );

  return {
    response: retryResponse,
    refreshSetCookies: refreshResult.setCookies,
    refreshed: true,
  };
}
