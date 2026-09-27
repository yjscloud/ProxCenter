/* ==========================================================================
   ProxCenter — 认证 Context
   ========================================================================== */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  hasSession,
  markSession,
  setUnauthorizedHandler,
  USER_KEY,
} from '../api/client';
import { authApi } from '../api/endpoints';
import type { LoginResponse, UserInfo } from '../api/types';

/* ---------------------------------------------------------------------------
   Context
   --------------------------------------------------------------------------- */

export interface AuthContextValue {
  user: UserInfo | null;
  /** 首次校验会话是否有效中 */
  initializing: boolean;
  /**
   * 登录第一步。开了两步验证的账号这次不会拿到令牌，返回体里是
   * `mfa_required: true` + `mfa_token`，由页面再调 `completeMfa`。
   */
  login: (
    username: string,
    password: string,
    /**
     * 登录验证的答案，形状跟着后端当前的方式走：
     * 图形码传 ``code``，滑块传 ``x``（拖动结束时拼图块的水平位置）。
     */
    captcha?: { id: string; code?: string; x?: number },
  ) => Promise<LoginResponse>;
  /** 登录第二步：动态码或一次性恢复码，成功后写入会话 */
  completeMfa: (mfaToken: string, code: string) => Promise<LoginResponse>;
  logout: () => Promise<void>;
  /** 退出所有设备（撤销全部会话，含当前这台） */
  logoutAll: () => Promise<void>;
  /** 重新拉取当前用户信息（改完个人信息后刷新缓存） */
  refresh: () => Promise<void>;
  /** 权限判断 */
  hasPermission: (perm: string) => boolean;
  /** 角色判断 */
  hasRole: (...roles: string[]) => boolean;
  /** 是否为管理员 */
  isAdmin: boolean;
  /** 是否可写（admin/operator）*/
  canWrite: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/* ---------------------------------------------------------------------------
   工具：本地缓存 user
   --------------------------------------------------------------------------- */

function readCachedUser(): UserInfo | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as UserInfo;
  } catch {
    return null;
  }
}

function writeCachedUser(user: UserInfo | null): void {
  try {
    if (user) {
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(USER_KEY);
    }
  } catch {
    /* 忽略 */
  }
}

/* ---------------------------------------------------------------------------
   Provider
   --------------------------------------------------------------------------- */

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<UserInfo | null>(() => readCachedUser());
  // 凭据在 HttpOnly Cookie 里读不到，只能靠自己记的标记判断「要不要先校验一次」
  const [initializing, setInitializing] = useState(() => hasSession());

  /* --- 清理会话 --- */
  const resetSession = useCallback(() => {
    markSession(false);
    writeCachedUser(null);
    setUser(null);
    queryClient.clear();
  }, [queryClient]);

  /* --- 注册 401 全局钩子 --- */
  useEffect(() => {
    setUnauthorizedHandler(() => {
      resetSession();
    });
    return () => setUnauthorizedHandler(null);
  }, [resetSession]);

  /* --- 启动时校验会话 --- */
  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      if (!hasSession()) {
        setInitializing(false);
        return;
      }
      try {
        // cookie 会随请求自动带上；401 时拦截器会先用 refresh cookie 续期再重试
        const me = await authApi.me();
        if (cancelled) return;
        setUser(me);
        writeCachedUser(me);
        markSession(true);
      } catch {
        if (cancelled) return;
        // 会话失效或后端不可达：清空本地状态
        markSession(false);
        writeCachedUser(null);
        setUser(null);
      } finally {
        if (!cancelled) setInitializing(false);
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  /* --- 把一次成功的登录/刷新结果写入本地会话 --- */
  const adoptSession = useCallback(
    (res: LoginResponse) => {
      if (!res.access_token) return; // 还需要第二步验证
      // 令牌本身由后端写进 HttpOnly Cookie，这里只更新状态与标记
      markSession(true);
      if (res.user) {
        writeCachedUser(res.user);
        setUser(res.user);
      }
      queryClient.clear();
    },
    [queryClient],
  );

  /* --- 登录（第一步；两步验证时返回 mfa_token） --- */
  const login = useCallback(
    async (
      username: string,
      password: string,
      captcha?: { id: string; code?: string; x?: number },
    ) => {
      const res = await authApi.login({
        username,
        password,
        captcha_id: captcha?.id ?? '',
        captcha_code: captcha?.code ?? '',
        captcha_x: captcha?.x,
      });
      adoptSession(res);
      return res;
    },
    [adoptSession],
  );

  /* --- 登录第二步：动态码 / 恢复码 --- */
  const completeMfa = useCallback(
    async (mfaToken: string, code: string) => {
      const res = await authApi.loginMfa({ mfa_token: mfaToken, code });
      adoptSession(res);
      return res;
    },
    [adoptSession],
  );

  /* --- 登出（撤销服务端会话，不只是清本地） --- */
  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      /* 后端失败也要清本地会话 */
    } finally {
      resetSession();
    }
  }, [resetSession]);

  /* --- 退出所有设备：后端会让全部令牌失效，含当前这台 --- */
  const logoutAll = useCallback(async () => {
    try {
      await authApi.logoutAll();
    } catch {
      /* 同上：无论如何清本地 */
    } finally {
      resetSession();
    }
  }, [resetSession]);

  /* --- 重新拉取用户信息（改完个人信息 / 权限变动后） --- */
  const refresh = useCallback(async () => {
    const me = await authApi.me();
    setUser(me);
    writeCachedUser(me);
  }, []);

  const hasPermission = useCallback(
    (perm: string) => {
      if (!user) return false;
      if (user.role === 'admin') return true;
      return user.permissions?.includes(perm) ?? false;
    },
    [user],
  );

  const hasRole = useCallback(
    (...roles: string[]) => {
      if (!user) return false;
      return roles.includes(user.role);
    },
    [user],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      initializing,
      login,
      completeMfa,
      logout,
      logoutAll,
      refresh,
      hasPermission,
      hasRole,
      isAdmin: user?.role === 'admin',
      canWrite: user?.role === 'admin' || user?.role === 'operator',
    }),
    [
      user,
      initializing,
      login,
      completeMfa,
      logout,
      logoutAll,
      refresh,
      hasPermission,
      hasRole,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/* ---------------------------------------------------------------------------
   Hook
   --------------------------------------------------------------------------- */

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth 必须在 <AuthProvider> 内部使用');
  }
  return ctx;
}
