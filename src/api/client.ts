/* ==========================================================================
   ProxCenter — axios 实例 + 拦截器
   ========================================================================== */

import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from 'axios';
import { detectLang, tStatic } from '../i18n';
import { clearScope, getGlobalScope } from './scope';

export const USER_KEY = 'pve_user';

/**
 * 「可能已登录」标记。
 *
 * 真正的凭据都在 HttpOnly Cookie 里，JS 读不到（这正是防 XSS 的意义），所以
 * 这里只存一个非敏感的布尔标记，用来决定首屏是否先显示「校验登录状态」。
 * 标记不准没关系：接口一调就会 401 → 自动刷新 → 失败则回登录页。
 */
export const AUTH_FLAG_KEY = 'pve_authed';

/** CSRF 双提交：后端下发的 cookie 名与要求的请求头名，必须一一对应 */
const CSRF_COOKIE = 'panel_csrf';
export const CSRF_HEADER = 'X-CSRF-Token';
const SAFE_METHODS = new Set(['get', 'head', 'options']);

/* ---------------------------------------------------------------------------
   ApiError
   --------------------------------------------------------------------------- */

/** 后端用 ``X-Error-Code`` 说明「同一状态码下的不同原因」；目前只有 428 用到。 */
const CONSOLE_CREDENTIALS_MISSING = 'console_credentials_missing';

/** 读取 ``X-Error-Code``；读不到就是空串（老后端、或响应头未 expose） */
function readErrorCode(headers: unknown): string {
  if (!headers || typeof headers !== 'object') return '';
  const get = (headers as { get?: (name: string) => unknown }).get;
  if (typeof get !== 'function') return '';
  return String(get.call(headers, 'x-error-code') ?? '');
}

export class ApiError extends Error {
  status: number;
  detail: string;
  /** 后端未实现（501）*/
  notImplemented: boolean;
  /** 认证失败 */
  unauthorized: boolean;
  /** 服务不可用（网络层错误 / 5xx）*/
  unavailable: boolean;
  /**
   * 前提未满足（428）—— 面板还没配置 Proxmox 连接。
   *
   * 这不是「出故障了」，而是「还没设置好」。页面据此换成引导态（去添加连接）
   * 而不是报错态，否则用户第一反应是「平台坏了」。
   */
  notConfigured: boolean;
  /** 后端 ``X-Error-Code`` 响应头（区分同一状态码下的不同原因），无则空串 */
  code: string;
  payload: unknown;

  constructor(
    message: string,
    status: number,
    payload?: unknown,
    code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = message;
    this.payload = payload;
    this.code = code ?? '';
    this.notImplemented = status === 501 || status === 404;
    this.unauthorized = status === 401 || status === 403;
    this.unavailable = status === 0 || status >= 500;
    /* 428 有两种：没配连接（该去添加）和没配控制台账号（该去补账号）。
       后者后端的文案已经说清了该做什么，再套一层「去添加连接」的引导反而是错的，
       所以按错误码把它排除在外。老后端不带码 → 一律当「没配连接」，与从前一致。 */
    this.notConfigured =
      status === 428 && (code ?? '') !== CONSOLE_CREDENTIALS_MISSING;
  }
}

/* ---------------------------------------------------------------------------
   会话标记 / CSRF
   --------------------------------------------------------------------------- */

export function hasSession(): boolean {
  try {
    return localStorage.getItem(AUTH_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

export function markSession(active: boolean): void {
  try {
    if (active) {
      localStorage.setItem(AUTH_FLAG_KEY, '1');
    } else {
      localStorage.removeItem(AUTH_FLAG_KEY);
      localStorage.removeItem(USER_KEY);
    }
  } catch {
    /* localStorage 不可用，忽略 */
  }
  if (!active) {
    /* 退出 / 会话失效时一并清掉集群作用域与连接缓存：它们描述的是「这个人在这个
       浏览器上的视角」，换个账号登录不该继承（对方可能看不到那条连接，
       第一批请求就会整片报「连接不存在」）。放在 try 外面，读不了
       localStorage 时也要清内存里那份。 */
    clearScope();
  }
}

/** 后端下发的 CSRF 令牌（非 HttpOnly，供前端回填请求头） */
export function readCsrfToken(): string {
  try {
    const match = document.cookie.match(
      new RegExp(`(?:^|;\\s*)${CSRF_COOKIE}=([^;]*)`),
    );
    return match ? decodeURIComponent(match[1]) : '';
  } catch {
    return '';
  }
}

/** 不需要 Authorization 的路径前缀 */
const PUBLIC_PATHS = [
  '/auth/login',
  // 登录验证码：未登录就要取
  '/auth/captcha',
  '/auth/register',
  // 自助重置密码：三个都是公开接口，未登录也要能调
  '/auth/forgot-password',
  '/auth/reset-password',
  // 换令牌只认 HttpOnly 里的 refresh cookie，不带 Authorization
  '/auth/refresh',
  '/health',
];

function isPublic(path: string): boolean {
  return PUBLIC_PATHS.some((p) => path.startsWith(p));
}

/* ---------------------------------------------------------------------------
   axios 实例
   --------------------------------------------------------------------------- */

const baseURL = import.meta.env.VITE_API_BASE || '/api';

export const http: AxiosInstance = axios.create({
  baseURL,
  timeout: 60_000,
  // refresh token 在 HttpOnly cookie 里：跨域（开发时的 5173 → 8080）也要带上
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
});

/* ---- 请求拦截器：带上 CSRF 头 ---- */
http.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    // 界面语言：后端据此返回权限目录 / FAQ / 内置角色名与错误消息
    // （见 backend/app/i18n.py）。这个模块在 React 之外，所以直接读持久化的语言。
    config.headers.set?.('Accept-Language', detectLang());
    /* 连接的三级优先级（详见 api/scope.ts）：
         调用点显式传的 X-PVE-Connection（硬指定）
         → 页面级连接 ?connection=（也是硬指定：这一页就是那台机器）
         → 顶栏「集群作用域」（**软**作用域，走另一个头）。
       用两个头而不是一个，是因为它们强度不同：
         * X-PVE-Connection —— 后端据此**不再**按节点 / VMID 自动定位
           （调用点已经知道机器在哪条连接上，别改它）；
         * X-PVE-Scope —— 只决定列表类接口读哪一套；后端能按节点 / VMID
           定位到别处时仍然允许纠正。若把软作用域也发成前者，作用域为 A 时
           操作 B 的机器会打到 A 上，任务轮询还会一直转圈
           （见 backend/app/pve.py 的说明）。
       都不存在时**什么都不发** —— 后端对列表类接口的「未指定 = 合并全部集群」
       分支就是靠它来判定的，塞一个空串反而会被当成「指定了连接」。 */
    if (!config.headers.has?.('X-PVE-Connection')) {
      if (pageConnection) {
        config.headers.set?.('X-PVE-Connection', pageConnection);
      } else if (!config.headers.has?.('X-PVE-Scope')) {
        const scope = getGlobalScope();
        if (scope) {
          config.headers.set?.('X-PVE-Scope', scope);
        }
      }
    }
    // 访问令牌在 HttpOnly Cookie 里，浏览器自动带 —— 这里只处理 CSRF：
    // 后端要求改状态的方法回填 X-CSRF-Token，值是那枚「非 HttpOnly」的 cookie。
    const method = (config.method ?? 'get').toLowerCase();
    if (!SAFE_METHODS.has(method)) {
      const csrf = readCsrfToken();
      if (csrf) {
        config.headers.set?.(CSRF_HEADER, csrf);
      }
    }
    return config;
  },
  (error: unknown) => Promise.reject(error),
);

/* ---- 401 处理钩子（由 AuthProvider 注入，避免循环依赖）---- */
type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

/* ---- 敏感操作二次确认钩子（由 StepUpProvider 注入）---- */
/**
 * 后端对删虚拟机、改连接凭据这类操作会返回 403 + ``X-Step-Up: required``。
 * 这里把它翻译成「弹框让用户重输密码（+ 动态码）」的异步回调，确认成功后
 * 自动重放原请求 —— 业务代码不需要自己处理。
 */
type StepUpHandler = (detail: string) => Promise<boolean>;
let onStepUpRequired: StepUpHandler | null = null;

export function setStepUpHandler(handler: StepUpHandler | null): void {
  onStepUpRequired = handler;
}

/* ---- 维护模式钩子（由 App 注入）---- */
/**
 * 后端在维护模式下对普通用户一律回 503 + ``X-Error-Code: maintenance``。
 *
 * 这里只做一件事：把「现在整站不可用」这件事告诉顶层，让它切到维护公告页。
 * 错误照旧 reject —— 页面级的错误提示该出现还得出，别把一次失败悄悄吞掉。
 */
const MAINTENANCE_CODE = 'maintenance';

type MaintenanceHandler = (message: string) => void;
let onMaintenance: MaintenanceHandler | null = null;

export function setMaintenanceHandler(handler: MaintenanceHandler | null): void {
  onMaintenance = handler;
}

/* ---- 从错误响应中提取 detail ---- */
function extractMessage(payload: unknown, fallback: string): string {
  if (!payload) return fallback;
  if (typeof payload === 'string') return payload;
  if (typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    // FastAPI: {detail: "..."} 或 {detail: validation_errors[]}
    const detail = obj.detail ?? obj.message ?? obj.error;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
      const first = detail[0];
      if (typeof first === 'string') return first;
      if (first && typeof first === 'object') {
        const f = first as Record<string, unknown>;
        const loc = Array.isArray(f.loc) ? f.loc.join('.') : '';
        const msg = typeof f.msg === 'string' ? f.msg : '';
        return loc ? `${loc}: ${msg}` : msg || fallback;
      }
    }
  }
  return fallback;
}

/** 后端要求二次确认（403 + ``X-Step-Up: required``）？ */
function isStepUpRequired(headers: unknown): boolean {
  if (!headers || typeof headers !== 'object') return false;
  const get = (headers as { get?: (name: string) => unknown }).get;
  if (typeof get !== 'function') return false;
  const value = String(get.call(headers, 'x-step-up') ?? '');
  return value.toLowerCase() === 'required';
}

/* ---- 自动续期：401 时用 refresh cookie 换一枚新 access token ---- */

/**
 * 单飞（single-flight）刷新。
 *
 * 页面同时发十几个请求、access token 恰好过期时，不能让它们各换一次令牌：
 * 后端每次刷新都会轮换 refresh token，并发刷新只会互相把对方作废。
 * 所以这里把并发请求收敛到同一个 promise。
 */
let refreshPromise: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        // 刻意用裸 axios：走 http 实例会再次进入本拦截器，401 时无限递归。
        // 新令牌直接由后端写进 HttpOnly Cookie，前端只关心成没成。
        // CSRF 头必须自己带上：这条请求用的是 Cookie 认证，且不经过请求拦截器。
        await axios.post(
          `${baseURL}/auth/refresh`,
          {},
          {
            withCredentials: true,
            timeout: 15_000,
            headers: { [CSRF_HEADER]: readCsrfToken() },
          },
        );
        markSession(true);
        return true;
      } catch {
        // 刷新失败（会话被撤销 / 过期 / 被踢下线）：交给调用方清会话
        return false;
      } finally {
        refreshPromise = null;
      }
    })();
  }
  return refreshPromise;
}

/* ---- 响应拦截器：统一错误处理 + 自动续期 ---- */
http.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    /* 网络层错误（后端未启动 / CORS / 超时）*/
    if (!error.response) {
      const isTimeout = error.code === 'ECONNABORTED';
      return Promise.reject(
        new ApiError(
          isTimeout ? tStatic('api.timeout') : tStatic('api.unreachable'),
          0,
          error.message,
        ),
      );
    }

    const { status, data } = error.response;
    const fallback = tStatic('api.httpFailed', { status });
    const message = extractMessage(data, fallback);

    if (status === 401) {
      const config = error.config as
        | (InternalAxiosRequestConfig & { _retried?: boolean })
        | undefined;
      const url = config?.url ?? '';
      // 只重试一次；刷新接口自身、公开接口都不走续期
      const canRetry =
        config && !config._retried && !isPublic(url) && !url.startsWith('/auth/refresh');

      if (canRetry && config) {
        config._retried = true;
        // 新令牌由后端写进 HttpOnly Cookie，重放时浏览器自动带上
        if (await refreshSession()) {
          return http.request(config);
        }
      }

      markSession(false);
      onUnauthorized?.();
      const text =
        typeof data === 'object' && data && 'detail' in data
          ? message
          : tStatic('api.sessionExpired');
      return Promise.reject(new ApiError(text, status, data));
    }

    // 敏感操作需要二次确认：后端用 403 + X-Step-Up 提示，这里弹框重验证后重放
    if (status === 403 && isStepUpRequired(error.response.headers)) {
      const config = error.config as
        | (InternalAxiosRequestConfig & { _stepped_up?: boolean })
        | undefined;
      if (config && !config._stepped_up && onStepUpRequired) {
        config._stepped_up = true;
        if (await onStepUpRequired(message)) {
          return http.request(config);
        }
      }
      return Promise.reject(new ApiError(message, status, data));
    }

    if (status === 501) {
      return Promise.reject(
        new ApiError(tStatic('api.notImplemented'), status, data),
      );
    }

    /* 维护模式：单独认一下错误码，通知顶层切到维护公告页（管理员不会收到它） */
    if (status === 503 && readErrorCode(error.response.headers) === MAINTENANCE_CODE) {
      onMaintenance?.(message);
      return Promise.reject(new ApiError(message, status, data, MAINTENANCE_CODE));
    }

    return Promise.reject(
      new ApiError(message, status, data, readErrorCode(error.response.headers)),
    );
  },
);

/* ---------------------------------------------------------------------------
   便捷请求方法
   --------------------------------------------------------------------------- */

export async function get<T>(
  url: string,
  config?: AxiosRequestConfig,
): Promise<T> {
  const res = await http.get<T>(url, config);
  return res.data;
}

/**
 * 与 {@link get} 相同，但把 ``X-Total-Count`` 一并带回来。
 *
 * 列表接口的 ``limit`` 是可选的：截断只影响这一页拿到多少条，**总数**由响应头
 * 给出。前端据此显示「已加载 500 / 共 3120」并决定要不要给「加载全部」。
 */
export async function getWithTotal<T>(
  url: string,
  config?: AxiosRequestConfig,
): Promise<{ data: T; total: number | null }> {
  const res = await http.get<T>(url, config);
  const raw = res.headers['x-total-count'];
  const parsed = raw === undefined || raw === null ? Number.NaN : Number(raw);
  return { data: res.data, total: Number.isFinite(parsed) ? parsed : null };
}

export async function post<T>(
  url: string,
  body?: unknown,
  config?: AxiosRequestConfig,
): Promise<T> {
  const res = await http.post<T>(url, body, config);
  return res.data;
}

export async function put<T>(
  url: string,
  body?: unknown,
  config?: AxiosRequestConfig,
): Promise<T> {
  const res = await http.put<T>(url, body, config);
  return res.data;
}

export async function del<T>(
  url: string,
  config?: AxiosRequestConfig,
): Promise<T> {
  const res = await http.delete<T>(url, config);
  return res.data;
}

/**
 * 为单次请求指定目标 PVE 连接（面板可配置多台 Proxmox）。
 *
 * 传了连接 id 就只打这一条连接；不传则**不表态**，由请求拦截器按
 * 「页面级连接 → 顶栏集群作用域」补上（见 api/scope.ts）。
 *
 * 非字符串入参会被安全忽略 —— 有些接口会被直接当作 react-query 的
 * `queryFn` 调用，此时第一个参数是查询上下文对象，不能被误当成连接 ID。
 */
export function scoped(connectionId?: unknown): AxiosRequestConfig {
  if (typeof connectionId !== 'string' || !connectionId) return {};
  return { headers: { 'X-PVE-Connection': connectionId } };
}

/* ---------------------------------------------------------------------------
   页面级 PVE 连接
   --------------------------------------------------------------------------- */

/**
 * 「当前页面属于哪条 PVE 连接」。
 *
 * 为什么需要它：节点名在每台 PVE 上都是**本地的**，多连接部署里光有节点名
 * 判断不出该打哪台机器（两台都可能叫 pve / pve9）。详情页只拿得到 node 名，
 * 于是请求落到「当前连接」，而那台 PVE 上没有该节点时会回一句
 * `hostname lookup 'xxx' failed` —— 看着像 PVE 的 DNS 坏了，其实是打错了机器。
 *
 * 详情页从列表页跳进来时 URL 上带着 ?connection=，挂载时设一次，页面里所有
 * 请求（含各 Tab 自己的查询）就都跟着走；离开时清掉，不影响别的页面。
 *
 * 它是**硬指定**（走 `X-PVE-Connection`），优先级高于顶栏的全局作用域：这一页
 * 讲的就是那台机器，别的页面偏好不该把它带偏。
 */
let pageConnection = '';

export function setPageConnection(id?: string | null): void {
  pageConnection = typeof id === 'string' && id ? id : '';
}

export async function upload<T>(
  url: string,
  formData: FormData,
  onProgress?: (percent: number) => void,
): Promise<T> {
  const res = await http.post<T>(url, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 0,
    onUploadProgress: (evt) => {
      if (!onProgress) return;
      const total = evt.total ?? 0;
      if (total > 0) {
        onProgress(Math.round((evt.loaded / total) * 100));
      }
    },
  });
  return res.data;
}

/**
 * 判断是否为「接口不存在」（404 / 501），用于 UI 优雅降级。
 *
 * 除了「功能未实现」，最常见的现实场景是**前端已更新、后端还在跑旧进程**：
 * 新页面调用的接口在旧后端上不存在，整块数据就变成「加载失败」，而通用提示写的
 * 是「后端不可达」——方向完全错了。调用方据此提示「重启/升级后端」，
 * 而不是让用户去查网络和 Proxmox。
 */
export function isNotImplemented(err: unknown): boolean {
  return err instanceof ApiError && err.notImplemented;
}

/**
 * 判断是否为「面板还没配置 Proxmox 连接」错误。
 *
 * 页面用它把「首次部署还没填连接」从错误态里摘出来，改渲染引导态。
 */
export function isNotConfigured(err: unknown): boolean {
  return err instanceof ApiError && err.notConfigured;
}

/** 把任意错误转成可展示文案 */
/* nginx 在后端没起来时回的是 HTML 错误页（<html>…502 Bad Gateway…），它被当成
   detail 直接显示出来的话，用户看到的是一整段 HTML，读不懂也帮不上忙 —— 这恰恰
   发生在「面板正在重启」这种过一会儿就好的场景里。统一换成一句人话。 */
const GATEWAY_BODY = /^\s*</;

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    /* 428（还没配置连接）后端的 detail 是给开发者看的英文技术文案，
       直接显示出来用户只会以为面板坏了。这里统一换成一句「该去做什么」的人话，
       所有沿用 errorMessage() 的页面无需改动就跟着变好。 */
    if (err.notConfigured) {
      return tStatic('api.pveNotConfigured');
    }
    if (err.status >= 502 && err.status <= 504 && GATEWAY_BODY.test(err.detail)) {
      return tStatic('api.gatewayDown');
    }
    // 413 同样是 nginx 直接回的 HTML 错误页，而它背后是一件用户自己能解决的事：
    // 文件比服务器的上传上限还大。说清楚原因和「那该怎么办」，别甩一坨 HTML。
    if (err.status === 413) {
      return tStatic('api.tooLarge');
    }
    return err.detail;
  }
  if (err instanceof Error) return err.message;
  return tStatic('api.unknown');
}
