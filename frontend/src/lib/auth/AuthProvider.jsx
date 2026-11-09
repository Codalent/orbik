"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { clearSession, subscribeSession } from "@/lib/api/client";

import * as authApi from "@/lib/api/auth";

const AuthContext = createContext(null);
const anonymousState = { status: "anonymous", user: null, destination: "login", selectedWorkspaceId: null };

/** Keeps session-derived UI state in memory; the API client owns CSRF and session expiry. */
export function AuthProvider({ children }) {
  const [state, setState] = useState({ ...anonymousState, status: "loading" });

  const refresh = useCallback(async () => {
    try { return await authApi.fetchSession(); }
    catch { clearSession(); return anonymousState; }
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeSession((session) => {
      if (!session) return setState(anonymousState);
      const { user, destination, selectedWorkspaceId, authenticated } = session;
      setState({ user, destination, selectedWorkspaceId, status: authenticated ? "authenticated" : "anonymous" });
    });
    void refresh();
    return unsubscribe;
  }, [refresh]);

  const authenticate = useCallback((credentials) => authApi.login(credentials), []);
  const signOut = useCallback(async () => {
    try { await authApi.logout(); } finally { clearSession(); }
  }, []);

  const value = useMemo(() => ({ ...state, authenticate, signOut, refresh }), [state, authenticate, signOut, refresh]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Returns the current auth context and fails fast outside its provider. */
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider.");
  return value;
}
