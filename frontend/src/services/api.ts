/**
 * Central API client for the Paper Finder frontend.
 * All HTTP requests to the backend go through this module.
 */

const getApiBase = () => {
  const url = import.meta.env.VITE_API_URL;
  if (!url) return "/api";
  const cleanUrl = url.replace(/\/$/, "");
  return cleanUrl.endsWith("/api") ? cleanUrl : `${cleanUrl}/api`;
};

const API_BASE = getApiBase();

// ── Token management ──

const TOKEN_KEY = "papervault_access_token";
const REFRESH_TOKEN_KEY = "papervault_refresh_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setTokens(accessToken: string, refreshToken: string): void {
  localStorage.setItem(TOKEN_KEY, accessToken);
  localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
}

export function clearTokens(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

// ── Fetch wrapper ──

interface ApiOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiFetch<T = unknown>(
  path: string,
  options: ApiOptions = {}
): Promise<T> {
  const { body, headers: extraHeaders, ...rest } = options;

  const headers: Record<string, string> = {
    ...(extraHeaders as Record<string, string>),
  };

  // Auto-attach auth token
  const token = getToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  // Set content-type for JSON bodies
  if (body && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    // Try to auto-refresh token on 401
    if (response.status === 401 && token) {
      const refreshed = await tryRefreshToken();
      if (refreshed) {
        // Retry the request with new token
        headers["Authorization"] = `Bearer ${getToken()}`;
        const retryResponse = await fetch(`${API_BASE}${path}`, {
          ...rest,
          headers,
          body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
        });
        if (retryResponse.ok) {
          return retryResponse.json() as Promise<T>;
        }
      }
      // If refresh failed, clear tokens
      clearTokens();
    }

    const errorData = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      (errorData as { error?: string }).error || `HTTP ${response.status}`
    );
  }

  return response.json() as Promise<T>;
}

async function tryRefreshToken(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;

  try {
    const response = await fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!response.ok) return false;

    const data = (await response.json()) as {
      session: {
        access_token: string;
        refresh_token: string;
      };
    };

    setTokens(data.session.access_token, data.session.refresh_token);
    return true;
  } catch {
    return false;
  }
}
