/* ==========================================================================
   ProxCenter — 全局集群作用域
   ==========================================================================

   面板把多条 PVE 连接当**同级**对待：不指定作用域时，列表类接口（节点 / 虚拟机 /
   存储）会合并全部连接一起返回。这在「看全貌」时是对的，但运维绝大多数时候只关心
   其中一套集群 —— 屏幕上混着四套机器的名字，反而看不清。

   于是有了这个「当前看哪一套集群」的用户级作用域，形状是一枚连接 id：

   * 空串 = **全部集群**（默认）。请求不带 ``X-PVE-Connection``，后端按各自的
     「未指定就聚合全部」分支处理；
   * 非空 = 聚焦某一条连接。前端给每个请求带上 ``X-PVE-Connection``，后端只查那一套。

   为什么存在前端（localStorage）而不是后端：它是**每个人自己的视角**，不是部署级
   配置。若存到服务端 settings，管理员甲切一下、管理员乙看到的读数立刻就变了 ——
   这正是原先「默认读取的 PVE」那个全局指针的毛病（它还留在设置页，但已降级为
   「未指定作用域时的兜底读取目标」，只服务健康探活这类无法带作用域的接口）。

   优先级（见 api/client.ts 的请求拦截器，从高到低）：
     1. 调用点显式传的 ``scoped(id)`` —— 请求头 ``X-PVE-Connection``；
     2. 页面级连接（详情页 URL 上的 ``?connection=``，由 ``setPageConnection`` 设置）
        —— 同样是 ``X-PVE-Connection``；
     3. 这里的全局作用域 —— 请求头 ``X-PVE-Scope``。

   1 与 2 是**硬指定**：后端由此认定「调用点知道机器在哪条连接上」，不再按节点 /
   VMID 去自动定位。3 是**软作用域**：它只决定列表类接口读哪一套集群，后端在能
   按节点 / VMID 定位到别处时仍然会纠正过去 —— 否则作用域是 A 时点开 B 上的机器，
   请求会打到 A（电源操作打到同名机器、任务轮询永远转圈）。

   失效自愈：连接被删除后，指向它的作用域会让**每一个** PVE 请求都回
   「目标 PVE 连接不存在或已被删除」。所以顶栏选择器拿到连接列表后会校验一次，
   发现作用域已不存在就自动回到「全部集群」。
   ========================================================================== */

/** 与其它界面偏好同一命名前缀（pve_*），见 api/client.ts 的 AUTH_FLAG_KEY */
const SCOPE_KEY = 'pve_scope';

/**
 * 服务端那份作用域的偏好键，**必须与后端 `app/prefs.py` 的 ``PREF_CLUSTER_SCOPE``
 * 一致**（那里是按 key 白名单 + 校验分支写的，对不上会直接 404/400）。
 */
export const SCOPE_PREF_KEY = 'cluster_scope';

/**
 * 已保存连接 id 的本地缓存。
 *
 * 为什么需要它：作用域指向的连接被删掉之后，带着它发出的**每一个** PVE 请求都会
 * 回「目标 PVE 连接不存在或已被删除」。若只能等连接列表回来才纠正，首屏会先闪
 * 一片错误（多标签页、慢网络下尤其明显）。缓存一份 id 列表就能在**发请求之前**
 * 判断作用域还有没有效 —— 列表本身很小（只有 id），且登录后马上会刷新。
 */
const CONNS_KEY = 'pve_conns';

function readCachedConnectionIds(): string[] | null {
  try {
    const raw = localStorage.getItem(CONNS_KEY);
    if (!raw) return null;
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return null;
    return data.filter((id): id is string => typeof id === 'string' && id !== '');
  } catch {
    /* 读不了 / 解析失败：当作「没有缓存」，退化为登录后的自愈 */
    return null;
  }
}

function readStoredScope(): string {
  let stored = '';
  try {
    stored = localStorage.getItem(SCOPE_KEY) ?? '';
  } catch {
    /* 隐私模式下读不了 localStorage：本次会话按「全部集群」开始 */
    return '';
  }
  if (!stored) return '';
  /* 有缓存就当场校验：指向已消失的连接时直接丢掉这个作用域，
     别拿它去发第一批请求。没缓存（首次打开、刚清过）就先信它，
     登录后 :func:`rememberConnections` 还会再兜一次。 */
  const cached = readCachedConnectionIds();
  if (cached && !cached.includes(stored)) {
    try {
      localStorage.removeItem(SCOPE_KEY);
    } catch {
      /* 忽略：上面已经返回了空串，本次会话不受影响 */
    }
    return '';
  }
  return stored;
}

/**
 * 模块级快照。
 *
 * 请求拦截器在 React 之外，每次请求都去读 localStorage 既慢又可能在隐私模式下抛错，
 * 所以这里存一份进程内副本，由 :func:`setGlobalScope` 同步维护。
 */
let globalScope = readStoredScope();

/** 当前作用域；空串表示「全部集群」。 */
export function getGlobalScope(): string {
  return globalScope;
}

/* 订阅者（见 hooks/useGlobalScope）：作用域一变就让相关组件重渲染 ——
   页面标题里的「几台节点」、选择器上显示的当前值都要跟着走。 */
const listeners = new Set<() => void>();

export function subscribeScope(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 切换作用域（空串 / null / undefined 都表示回到「全部集群」）。 */
export function setGlobalScope(id?: string | null): void {
  const next = typeof id === 'string' ? id : '';
  if (next === globalScope) return;
  globalScope = next;
  try {
    if (globalScope) {
      localStorage.setItem(SCOPE_KEY, globalScope);
    } else {
      localStorage.removeItem(SCOPE_KEY);
    }
  } catch {
    /* 写不进去不影响本次会话：模块级副本已经更新 */
  }
  listeners.forEach((listener) => listener());
}

/**
 * 记下当前账号能看到的连接 id（顶栏选择器每次拿到连接列表时调用）。
 *
 * 两件事：
 *   1. 写入缓存，供**下次启动**在发请求之前校验作用域（见 :func:`readStoredScope`）；
 *   2. 当场纠正 —— 作用域指向的连接已经不在了（在别的设备上被删掉、或换了面板
 *      部署）就清掉它。
 *
 * 返回「是否清掉了失效的作用域」，调用方据此决定要不要让页面数据重新取一遍。
 */
export function rememberConnections(ids: string[]): boolean {
  try {
    localStorage.setItem(CONNS_KEY, JSON.stringify(ids));
  } catch {
    /* 隐私模式：校验退化为「登录后由这里纠正」，功能不受影响 */
  }
  if (globalScope && !ids.includes(globalScope)) {
    setGlobalScope('');
    return true;
  }
  return false;
}

/**
 * 退出登录时清干净。
 *
 * 作用域与连接缓存都是「这个人在这个浏览器上的视角」：下一个登录的人可能是另一个
 * 账号（也许看不到那条连接），继承过去会让他的第一批请求就报「连接不存在」。
 */
export function clearScope(): void {
  setGlobalScope('');
  try {
    localStorage.removeItem(CONNS_KEY);
  } catch {
    /* 忽略 */
  }
}
