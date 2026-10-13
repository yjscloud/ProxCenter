/* ==========================================================================
   ProxCenter — 认证 Context
   ========================================================================== */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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
import type { PermissionKey } from '../api/permissions';
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
  /** 权限判断（键取 ``api/permissions.ts``，写错编译不过） */
  hasPermission: (perm: PermissionKey) => boolean;
  /** 角色判断 */
  hasRole: (...roles: string[]) => boolean;
  /** 是否为管理员 */
  isAdmin: boolean;
  /** 是否可写（admin/operator）*/
  canWrite: boolean;
}

/**
 * 这个用户能不能做写操作（整块区域的**粗判**）。
 *
 * **不能按角色名判断**：自定义角色（管理员在「角色管理」里拼出来的那种）不等于
 * ``operator``，但它完全可能有 ``vm.power`` / ``vm.snapshot`` 这类权限 —— 按角色
 * 名判会把它们一律当成只读，表现就是「明明勾了权限却点不动」。
 *
 * 这里的口径是「拥有任意一个非 ``.view`` 权限」，只回答「这个人是不是纯只读」。
 * **具体某一项操作该用哪个权限，仍要单独判断**（``hasPermission('vm.power')``）：
 * 粗判为 true 只说明他不是只读用户，不代表他能做这一件事。
 */
function canWriteFor(user: UserInfo | null): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return (user.permissions ?? []).some((perm) => !perm.endsWith('.view'));
}

/**
 * 权限判定的**唯一口径**：超管短路 + ``*`` 通配 + 具体键。
 *
 * 关于 ``*``：后端 ``_has()`` 认它（``"*" in perms``），而它不只在内置超管角色上
 * 出现 —— 历史数据里，自定义角色或用户级覆盖都可能带着 ``["*"]``。前端只认具体键
 * 的话，这类账号会「后端放行一切、界面一个菜单都看不到」，两边看到的不是同一个系统。
 * （后端现在已拒绝写入这种权限，这里兜的是存量数据。）
 *
 * 侧边栏 / 命令面板的菜单可见性（``canAccessNav``）也调这一份，避免两处各判各的。
 */
export function userHasPermission(
  user: { role?: string; permissions?: string[] } | null | undefined,
  perm: PermissionKey,
): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const granted = user.permissions ?? [];
  return granted.includes('*') || granted.includes(perm);
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
    (perm: PermissionKey) => userHasPermission(user, perm),
    [user],
  );

  /* --- 权限快照的保鲜 ---
     界面判定用的是**登录那一刻**下发的 permissions，管理员改了角色之后，已登录用户
     要等到重新登录才看得到变化。后端每次请求都重新查库（见 security._user_view），
     所以不会越权，但会出现「按钮还在、点一下 403」——用户只会以为面板坏了。

     切回这个标签页时重新拉一次即可，成本是一次轻请求。两条纪律：
     * 掐一个下限，频繁切标签不该把 /me 打成心跳；
     * 失败静默 —— 拉不到就继续用手上的快照，别把网络问题升级成权限问题。 */
  const lastRefreshRef = useRef(0);
  useEffect(() => {
    if (!user) return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastRefreshRef.current < 60_000) return;
      lastRefreshRef.current = Date.now();
      void refresh().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [user, refresh]);

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
      canWrite: canWriteFor(user),
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
