/* ==========================================================================
   ProxCenter — 节点实时指标流
   后端把逐页的轮询集中到一条 WebSocket 上：页面只要挂着这个 hook，
   指标就按服务端的节奏自动更新，不需要自己再 setInterval。
   ========================================================================== */

import { useEffect, useState } from 'react';
import { metricsWsUrl } from '../api/endpoints';
import { useDocumentVisible } from './useDocumentVisible';

export interface NodeMetric {
  node: string;
  status?: string;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  loadavg?: number | string | Array<number | string>;
  uptime?: number;
}

/* 重连退避：5s 起，逐次翻倍，5 分钟封顶。
   固定 5 秒重试的问题在于「连不上」和「没凭据」长得一样 —— 浏览器只给一个
   code 1006，分不出是对端拒绝还是网络抖动。而会话失效后这个状态会持续很久
   （要等到某次 HTTP 请求触发续期），固定间隔就会在这段时间里一直空转刷服务端
   日志。指数退避把长期失败的成本压到每分钟一次量级，同时又不影响短暂抖动后的
   快速恢复 —— 连上就把计数清零。 */
const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 300_000;

export function useMetricsStream(enabled: boolean): {
  metrics: Record<string, NodeMetric>;
  connected: boolean;
} {
  const [metrics, setMetrics] = useState<Record<string, NodeMetric>>({});
  const [connected, setConnected] = useState(false);
  const visible = useDocumentVisible();

  useEffect(() => {
    // 不可见时索性不连：既省服务端的空握手，也避免后台标签页刷出满屏 403。
    // 依赖里的 visible 一变，这个 effect 会重新跑并立刻连上。
    if (!enabled || !visible) return;

    let ws: WebSocket | null = null;
    let alive = true;
    let attempt = 0;
    let timer: number | undefined;

    const connect = () => {
      if (!alive) return;
      ws = new WebSocket(metricsWsUrl());
      ws.onopen = () => {
        attempt = 0; // 连上了就把退避清零，下一次断线仍能快速恢复
        setConnected(true);
      };
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as {
            type?: string;
            nodes?: NodeMetric[];
          };
          if (data.type === 'metrics' && Array.isArray(data.nodes)) {
            const next: Record<string, NodeMetric> = {};
            for (const item of data.nodes) {
              if (item?.node) next[item.node] = item;
            }
            setMetrics(next);
          }
        } catch {
          /* 忽略无法解析的帧 */
        }
      };
      ws.onclose = () => {
        setConnected(false);
        // 断线静默重连：监控页通常常年开着，比让用户手动刷新友好
        if (!alive) return;
        const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(attempt, 6));
        attempt += 1;
        timer = window.setTimeout(connect, delay);
      };
      ws.onerror = () => ws?.close();
    };

    connect();

    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
      ws?.close();
      setConnected(false);
    };
  }, [enabled, visible]);

  return { metrics, connected };
}
