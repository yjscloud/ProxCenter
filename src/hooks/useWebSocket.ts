/* ==========================================================================
   ProxCenter — WebSocket：任务进度推送
   ========================================================================== */

import { useCallback, useEffect, useRef, useState } from 'react';
import { taskWsUrl } from '../api/endpoints';
import type { TaskWsMessage } from '../api/types';
import { useDocumentVisible } from './useDocumentVisible';

export type WsStatus = 'connecting' | 'open' | 'closed' | 'error';

export interface UseWebSocketResult {
  status: WsStatus;
  /**
   * 最近收到的消息（快照，不触发渲染）。
   *
   * 需要逐条处理请用 ``onMessage``：这里是给「打开面板时想看一眼最后一条」
   * 这类场景的，不要拿它做数据源 —— 它只在组件因别的原因重渲染时才更新。
   */
  lastMessage: TaskWsMessage | null;
  /** 手动重连 */
  reconnect: () => void;
  /** 主动断开 */
  disconnect: () => void;
}

export interface UseWebSocketOptions {
  /** 是否启用（如未登录时禁用）*/
  enabled?: boolean;
  /** 收到消息回调 */
  onMessage?: (msg: TaskWsMessage) => void;
  /** 重连最大退避时间（毫秒）*/
  maxBackoff?: number;
  /** 是否自动重连，默认 true */
  autoReconnect?: boolean;
}

/**
 * 连接 /api/ws/tasks，接收 {upid,node,status,progress,log} 推送。
 * 断线自动指数退避重连。
 */
export function useWebSocket(
  options: UseWebSocketOptions = {},
): UseWebSocketResult {
  const {
    enabled = true,
    onMessage,
    maxBackoff = 15_000,
    autoReconnect = true,
  } = options;

  const [status, setStatus] = useState<WsStatus>('closed');
  /* 最近一条消息**不进 state**：它只是「方便看一眼」的快照，没有任何消费者
     需要靠它触发渲染（逐条处理走 onMessage）。放进 state 的代价是每条日志
     —— 备份一个文件能刷几百条 —— 都让页面重渲染一次，正好和 F12 的批量
     flush 互相抵消。 */
  const lastMessageRef = useRef<TaskWsMessage | null>(null);
  const visible = useDocumentVisible();

  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedByUserRef = useRef(false);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const disconnect = useCallback(() => {
    closedByUserRef.current = true;
    clearTimer();
    const ws = socketRef.current;
    socketRef.current = null;
    if (ws) {
      // 移除 handler 防止触发重连
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.onopen = null;
      try {
        ws.close();
      } catch {
        /* 忽略 */
      }
    }
    setStatus('closed');
  }, [clearTimer]);

  const connect = useCallback(() => {
    if (!enabled) return;
    // 已有连接则先关闭
    if (socketRef.current) {
      const prev = socketRef.current;
      socketRef.current = null;
      prev.onclose = null;
      prev.onerror = null;
      prev.onmessage = null;
      prev.onopen = null;
      try {
        prev.close();
      } catch {
        /* 忽略 */
      }
    }

    closedByUserRef.current = false;
    setStatus('connecting');

    let ws: WebSocket;
    try {
      ws = new WebSocket(taskWsUrl());
    } catch {
      setStatus('error');
      return;
    }
    socketRef.current = ws;

    ws.onopen = () => {
      retryRef.current = 0;
      setStatus('open');
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      try {
        const data = JSON.parse(event.data) as TaskWsMessage;
        if (data && typeof data.upid === 'string') {
          lastMessageRef.current = data;
          onMessageRef.current?.(data);
        }
      } catch {
        /* 非 JSON 消息忽略 */
      }
    };

    ws.onerror = () => {
      setStatus('error');
    };

    ws.onclose = () => {
      if (socketRef.current === ws) {
        socketRef.current = null;
      }
      setStatus('closed');
      if (closedByUserRef.current || !autoReconnect || !enabled) return;

      // 指数退避重连
      const attempt = retryRef.current;
      retryRef.current = attempt + 1;
      const delay = Math.min(maxBackoff, 1_000 * 2 ** Math.min(attempt, 4));
      clearTimer();
      timerRef.current = setTimeout(() => {
        connect();
      }, delay);
    };
  }, [enabled, autoReconnect, maxBackoff, clearTimer]);

  const reconnect = useCallback(() => {
    retryRef.current = 0;
    clearTimer();
    connect();
  }, [connect, clearTimer]);

  useEffect(() => {
    // 不可见时断开且不重连：后台标签页的访问令牌过期后拿不到续期（React Query
    // 默认不在后台轮询），这时重连只会一遍遍被 403 拒掉、把日志刷满。切回前台
    // 会重新执行这个 effect 并立刻连上，配合窗口聚焦时的重新取数不会丢状态。
    if (!enabled || !visible) {
      disconnect();
      return;
    }
    connect();
    return () => {
      disconnect();
    };
  }, [enabled, visible, connect, disconnect]);

  return { status, lastMessage: lastMessageRef.current, reconnect, disconnect };
}

/* ---------------------------------------------------------------------------
   任务进度辅助：把消息归并到 upid → 最新消息 的 Map
   --------------------------------------------------------------------------- */

export function useTaskStream(enabled = true): {
  status: WsStatus;
  /** upid → 最新消息 */
  messages: Record<string, TaskWsMessage>;
  reconnect: () => void;
} {
  const [messages, setMessages] = useState<Record<string, TaskWsMessage>>({});

  const handleMessage = useCallback((msg: TaskWsMessage) => {
    setMessages((prev) => ({ ...prev, [msg.upid]: msg }));
  }, []);

  const { status, reconnect } = useWebSocket({
    enabled,
    onMessage: handleMessage,
  });

  return { status, messages, reconnect };
}
