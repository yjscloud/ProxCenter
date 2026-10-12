/* ==========================================================================
   ProxCenter — 全新部署时的「初始化入口」

   面板一次都没配过 Proxmox 连接时，让管理员登录后直接落到初始化流程上
   （连接管理页 + 自动摊开新增表单），而不是先看到仪表盘上一句
   「还没接入 Proxmox 主机」。

   三条约束，都是为了让「帮忙」别变成「骚扰」：

   1. **只引导一次**。跳过之后就不再干预 —— 不管是配好了，还是用户自己走开了。
      记在 localStorage 里，另外用一个 ref 兜住隐私模式：没有它，用户从连接
      管理页点回仪表盘会被立刻弹回去，变成走不掉的循环。
   2. **只在确定没配置时才跳**。探测还没回来、或探测根本失败时都不跳 ——
      不能因为后端刚重启，就把人从一个正在看的页面上拽走。
   3. **只有管理员跳**。普通用户没有改连接的权限，带他过去只会看到一个
      只读页面。

   填地址 / Token、测连通、跑诊断这些真正的「向导」内容都在连接管理页里，
   这里只负责把人带到那儿，不重复实现一套表单。
   ========================================================================== */

import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { usePveStatus } from '../hooks/usePveStatus';

/* 与 SetupRequired / PveSetupNotice 用同一个目标：连接管理页 */
const SETUP_PATH = '/nodes/connections';

/** 已引导过的标记。只跳过**这一次全新部署**，连接被删掉后还能再引导 */
const REDIRECTED_KEY = 'pve_setup_redirected';

function readRedirected(): boolean {
  try {
    return localStorage.getItem(REDIRECTED_KEY) === '1';
  } catch {
    /* 隐私模式读不到：当作没引导过，本次会话由 ref 兜住 */
    return false;
  }
}

function markRedirected(): void {
  try {
    localStorage.setItem(REDIRECTED_KEY, '1');
  } catch {
    /* 忽略 */
  }
}

export function SetupRedirect() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { isAdmin } = useAuth();
  const { configured, loading, hasData } = usePveStatus();

  /* 本次会话已经引导过：隐私模式下 localStorage 记不住，靠它避免反复弹 */
  const done = useRef(readRedirected());

  useEffect(() => {
    if (done.current || loading || !isAdmin) return;

    /* 探测没有结果（后端不可达）时什么都不做：不把人从页面上拽走，也不去改写
       「已经引导过」的标记 —— 一次失败的探测不该被当成「已经配置好了」。 */
    if (!hasData) return;

    if (configured) {
      /* 配好了就把标记清掉：将来连接被删掉，还能再引导一次 */
      try {
        localStorage.removeItem(REDIRECTED_KEY);
      } catch {
        /* 忽略 */
      }
      return;
    }

    /* 人已经在初始化页面上（可能是上一轮带过来的）：算作已引导，
       从这里走开之后不再被弹回来 */
    done.current = true;
    markRedirected();
    if (pathname.startsWith(SETUP_PATH)) return;

    /* replace：不在历史里留一条「仪表盘」，否则用户按返回又回到引导前的位置 */
    navigate(`${SETUP_PATH}?new=1`, { replace: true });
  }, [configured, loading, hasData, isAdmin, pathname, navigate]);

  return null;
}
