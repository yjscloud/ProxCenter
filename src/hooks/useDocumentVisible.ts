/* ==========================================================================
   ProxCenter — 页面是否处于前台
   ========================================================================== */

import { useEffect, useState } from 'react';

/**
 * 页面是否在前台（可见）。
 *
 * WebSocket 只在可见时维持连接，原因是**后台标签页拿不到续期**：React Query 的
 * refetchInterval 在标签页不可见时默认不执行（`refetchIntervalInBackground`
 * 默认 false），于是访问令牌过期后没有任何 HTTP 请求去触发刷新，而 WS 还在原地
 * 重连 —— 每次握手都因为没凭据被 403 拒掉。
 *
 * 一个被遗忘在后台的标签页就能刷出成千上万条 403：日志被淹、真实故障难找，
 * 服务端还要为每一次空握手白跑一遍来源与令牌校验。而此刻用户根本看不到这块
 * 界面，维持连接没有任何意义。
 *
 * 切回前台时 hook 会翻成 true，调用方的 effect 重新执行、立刻补一次连接；
 * 加上 React Query 默认的「窗口聚焦即重新取数」，回到页面上数据就是新的。
 */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => !document.hidden);

  useEffect(() => {
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  return visible;
}
