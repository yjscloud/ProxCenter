/* ==========================================================================
   ProxCenter — 任务等待：写操作返回 {task: upid} 后轮询直到结束
   ========================================================================== */

import { useCallback } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { tasksApi } from '../api/endpoints';
import { ApiError, errorMessage } from '../api/client';
import { invalidateQuota } from './quotaCache';
import { useToast } from './useToast';
import { useT } from '../i18n';
import type { TaskInfo } from '../api/types';

export interface RunTaskOptions {
  /** toast 标题，如 "启动虚拟机" */
  title: string;
  /**
   * 任务所属节点。可选 —— UPID 本身已编码节点名，后端会自动解析，
   * 仅在极少数无法解析的场景才需要显式传入。
   */
  node?: string;
  /** 完成后需要刷新的 query key */
  invalidate?: QueryKey[];
  /** 轮询间隔，默认 1500ms */
  interval?: number;
  /** 超时时间，默认 10 分钟 */
  timeout?: number;
  /** 成功回调 */
  onSuccess?: (task: TaskInfo) => void;
  /** 失败回调 */
  onError?: (task: TaskInfo) => void;
  /**
   * 破坏性操作（删除 / 隔离 / 回滚）：成功也用更醒目的一档通知。
   * 这类动作不可撤销，绿勾很容易被当成「什么都没发生」划过去。
   */
  destructive?: boolean;
}

/**
 * 任意写操作的返回值。含 `task` 字段时表示这是一个需要等待的 Proxmox 任务；
 * 不含时（如创建备份计划、删除任务记录）视为同步操作，直接报成功。
 *
 * 用 unknown 而不是具体接口：TypeScript 不允许具体 interface 赋值给带索引签名的
 * 类型，也不接受缺少可选属性的对象。unknown 让调用方可以传入任意形状的返回值，
 * 运行时只读取 `task` 字段。
 */
export interface TaskRunner {
  /** 传入写操作的返回值，若含 task 则等待其完成 */
  run: (
    promiseOrResult: unknown,
    options: RunTaskOptions,
  ) => Promise<TaskInfo | null>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 任务等待 hook。
 *
 * ```ts
 * const runner = useTaskRunner();
 * await runner.run(vmsApi.start(node, vmid), {
 *   title: '启动虚拟机',
 *   node,
 *   invalidate: [['vms'], ['vm', node, vmid]],
 * });
 * ```
 */
export function useTaskRunner(): TaskRunner {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();

  /**
   * 任务结束后的统一刷新：调用方给的那几份 + **额度读数无条件一起作废**。
   *
   * 为什么额度要无条件作废：任何一个任务都是一次写操作 —— 可能多了一台机器、
   * 少了一台、改了规格、动了快照、换了归属，每一样都会让额度读数变。而额度
   * 只有几个小查询，无条件刷新的代价远低于「某个调用点忘了刷新」的代价：
   * 「删了机器额度没还回来」「额度改完还是旧数字」这两类问题连着出过好几次，
   * 根因都是要求几十个调用点各自记得同一件事。
   *
   * 放在 runner 里（全站写操作的集中入口）而不是散在调用点，等于从机制上
   * 消掉这类 bug —— 以后新增的写操作也不会再漏。
   */
  const flush = useCallback(
    (keys: QueryKey[]) => {
      for (const key of keys) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
      invalidateQuota(queryClient);
    },
    [queryClient],
  );

  const run = useCallback<TaskRunner['run']>(
    async (promiseOrResult, options) => {
      const {
        title,
        node,
        invalidate = [],
        interval = 1_500,
        timeout = 600_000,
        onSuccess,
        onError,
        destructive = false,
      } = options;

      /* ---- 1. 发起请求 ---- */
      let upid: string | undefined;
      const toastId = toast.loading(title, t('task.submitting'));

      try {
        const result = await Promise.resolve(promiseOrResult);
        if (result && typeof result === 'object' && 'task' in result) {
          const value = (result as { task?: unknown }).task;
          if (typeof value === 'string') upid = value;
        }
      } catch (err) {
        toast.dismiss(toastId);
        toast.error(t('task.failed', { title }), errorMessage(err));
        throw err;
      }

      /* ---- 2. 无 upid：视为同步操作，直接成功 ---- */
      if (!upid) {
        toast.dismiss(toastId);
        if (destructive) toast.destructive(t('task.succeeded', { title }));
        else toast.success(t('task.succeeded', { title }));
        flush(invalidate);
        return null;
      }

      /* ---- 3. 轮询任务状态 ---- */
      toast.update(toastId, {
        type: 'info',
        title,
        message: t('task.running'),
        loading: true,
        persistent: true,
      });

      const started = Date.now();
      let lastTask: TaskInfo | null = null;
      /* 连续轮询失败计数。主机选错、任务被清理、网络异常时，旧逻辑会一直
         continue 到 10 分钟超时才收尾，界面上就是「关机中 / 删除中」永不结束。 */
      let failures = 0;
      const MAX_FAILURES = 5;

      try {
        for (;;) {
          await sleep(interval);

          if (Date.now() - started > timeout) {
            toast.update(toastId, {
              type: 'warning',
              title,
              message: t('task.timeout'),
              loading: false,
              persistent: false,
            });
            return lastTask;
          }

          let task: TaskInfo;
          try {
            task = await tasksApi.detail(upid, node);
          } catch (err) {
            // 轮询期间的网络抖动：记录但不中断（除非认证失败）
            const msg = errorMessage(err);
            if (/登录|认证|login|auth/i.test(msg)) {
              toast.update(toastId, {
                type: 'error',
                title,
                message: msg,
                loading: false,
                persistent: false,
              });
              throw err;
            }

            failures += 1;
            const missing = err instanceof ApiError && err.status === 404;
            if (missing || failures >= MAX_FAILURES) {
              /* 拿不到任务状态不代表操作没执行 —— PVE 那边通常已经完成，
                 所以照常刷新列表，让界面回到真实状态。 */
              toast.update(toastId, {
                type: 'warning',
                title,
                message: missing ? t('task.missing') : t('task.unreachable'),
                loading: false,
                persistent: false,
              });
              flush(invalidate);
              return lastTask;
            }
            continue;
          }
          failures = 0;

          lastTask = task;

          if (task.status !== 'running') {
            const exit = task.exitstatus ?? '';
            const ok = exit === 'OK';
            const warn = !ok && exit.startsWith('WARNINGS');

            if (ok) {
              toast.update(toastId, {
                type: destructive ? 'destructive' : 'success',
                title: t('task.succeeded', { title }),
                message: undefined,
                loading: false,
                persistent: false,
              });
              flush(invalidate);
              onSuccess?.(task);
            } else if (warn) {
              toast.update(toastId, {
                type: 'warning',
                title: t('task.doneWarn', { title }),
                message: exit,
                loading: false,
                persistent: false,
              });
              flush(invalidate);
              onSuccess?.(task);
            } else {
              const message = exit || t('task.interrupted');
              toast.update(toastId, {
                type: 'error',
                title: t('task.failed', { title }),
                message,
                loading: false,
                persistent: false,
              });
              onError?.(task);
              // 失败也刷新，保证列表状态与后端一致
              flush(invalidate);
            }
            return task;
          }
        }
      } finally {
        /* 轮询异常退出（超时/认证失败）时清理 loading toast；
           正常结束时 toast 已是终态，dismiss 对其无影响。 */
        if (!lastTask || lastTask.status === 'running') {
          toast.dismiss(toastId);
        }
      }
    },
    [toast, queryClient, t],
  );

  return { run };
}

/* ---------------------------------------------------------------------------
   简易轮询等待（不依赖 toast，供内部使用）
   --------------------------------------------------------------------------- */

export async function waitForTask(
  upid: string,
  node?: string,
  options: { interval?: number; timeout?: number } = {},
): Promise<TaskInfo> {
  const { interval = 1_500, timeout = 600_000 } = options;
  const started = Date.now();

  for (;;) {
    const task = await tasksApi.detail(upid, node);
    if (task.status !== 'running') return task;
    if (Date.now() - started > timeout) return task;
    await sleep(interval);
  }
}
