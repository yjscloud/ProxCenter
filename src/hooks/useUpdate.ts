/* ==========================================================================
   ProxCenter — 面板更新（检查新版本 / 一键更新）

   只对「设置管理」权限开放：后端接口本身也这么拦。`enabled` 由调用方按权限传进来，
   普通用户不该看到这组接口被调用的痕迹。

   三个 mutation 都只是薄封装：**「能不能一键更新」的判定完全在后端**（那里看得见
   部署形态：容器 / 非 git / 非 systemd 托管 / 非 root / 没有 Node / 工作区有改动），
   前端不做第二套规则 —— 两套规则迟早会不一致，而不一致的那次正好会在更新面板时发作。
   ========================================================================== */

import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../api/client';
import { updateApi } from '../api/endpoints';
import type { UpdateStatus } from '../api/types';
import { useT } from '../i18n';
import { useToast } from './useToast';

export const UPDATE_STATUS_KEY = ['update-status'] as const;

/** 版本不会几分钟就变一次：默认半小时查一次，切回页面时按 staleTime 重取。 */
const IDLE_INTERVAL = 30 * 60 * 1000;
const STALE_TIME = 5 * 60 * 1000;
/** 更新进行中时的轮询间隔：更新要跑几分钟，慢一点也够用。 */
const BUSY_INTERVAL = 5000;

/** 只有「这一次会话里真的发起过更新」才允许在版本变化后自动刷新页面。
 *  放在模块级是为了让提示条与设置页共用一份判断（两个组件同时挂载时
 *  各刷一次页面会很难看）。 */
let reloadArmed = false;

export function useUpdateStatus(enabled: boolean) {
  const query = useQuery({
    queryKey: UPDATE_STATUS_KEY,
    queryFn: updateApi.status,
    enabled,
    staleTime: STALE_TIME,
    refetchInterval: IDLE_INTERVAL,
    retry: false,
  });

  const current = query.data?.current ?? '';
  const applying = Boolean(query.data?.applying?.tag);
  const refetch = query.refetch;

  /* 更新进行中：5 秒问一次（更新脚本在后台跑，面板随时会重启） */
  useEffect(() => {
    if (!applying) return undefined;
    const timer = window.setInterval(() => void refetch(), BUSY_INTERVAL);
    return () => window.clearInterval(timer);
  }, [applying, refetch]);

  /* 面板重启回来之后，页面里还是**旧前端的 JS**：版本号变了就自动刷新一次。
     只在发起过更新的会话里做 —— 用户自己在命令行升级时，不该看到页面无缘无故
     自己刷新。 */
  const baseline = useRef('');
  if (current && !baseline.current) baseline.current = current;
  useEffect(() => {
    if (applying) {
      reloadArmed = true;
      return;
    }
    if (reloadArmed && current && current !== baseline.current) {
      reloadArmed = false;
      window.setTimeout(() => window.location.reload(), 1500);
    }
  }, [applying, current]);

  return query;
}

/** 手动检查。失败（网络 / 限额）不抛错：原因在返回的 error 字段里，界面照常可用。 */
export function useCheckUpdate() {
  const qc = useQueryClient();
  const toast = useToast();
  const t = useT();
  return useMutation({
    mutationFn: () => updateApi.check(),
    onSuccess: (data: UpdateStatus) => {
      qc.setQueryData(UPDATE_STATUS_KEY, data);
      if (data.error) {
        toast.warning(t('update.checkFailed'), data.error);
      } else if (data.update_available) {
        toast.success(t('update.checkDone'), `v${data.latest}`);
      } else {
        toast.success(t('update.checkDone'), t('update.upToDate'));
      }
    },
    onError: (err) => toast.error(t('update.checkFailed'), errorMessage(err)),
  });
}

/** 改自动检查 / 跳过版本 / 发布仓库。换仓库会触发后端的二次确认（解析器自动弹框）。 */
export function useSaveUpdateSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const t = useT();
  return useMutation({
    mutationFn: updateApi.saveSettings,
    onSuccess: (data: UpdateStatus) => {
      qc.setQueryData(UPDATE_STATUS_KEY, data);
      toast.success(t('update.settingsSaved'));
    },
    onError: (err) => toast.error(t('update.settingsFailed'), errorMessage(err)),
  });
}

/** 一键更新：接口立刻返回，真正的活在后台脚本里跑（面板随后会重启）。 */
export function useApplyUpdate() {
  const qc = useQueryClient();
  const toast = useToast();
  const t = useT();
  return useMutation({
    mutationFn: (body: { tag?: string; allow_dirty?: boolean }) => updateApi.apply(body),
    onSuccess: (data) => {
      toast.success(t('update.applyStarted'), data.log);
      // 立刻重取一次：状态里会出现 applying，界面据此切到「更新进行中」
      void qc.invalidateQueries({ queryKey: UPDATE_STATUS_KEY });
    },
    onError: (err) => toast.error(t('update.applyFailed'), errorMessage(err)),
  });
}
