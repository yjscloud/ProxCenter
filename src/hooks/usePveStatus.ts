/* ==========================================================================
   ProxCenter — 面板的 Proxmox 连接状态

   只回答一个问题：**面板填过连接没有**。

   为什么值得单独抽出来：未配置时后端对几乎所有业务接口都返回 428，如果各页面
   各自判断，就是十几处「红色报错 + 英文原文」；统一到这一处之后，全局引导条
   与各页面的引导态读的是同一份状态，不会出现「导航说没配、页面说连不上」。

   数据源用免登录的 `/health`：普通用户没有读连接列表的权限，但同样需要知道
   「现在是系统没配好，不是我点坏了」。
   ========================================================================== */

import { useQuery } from '@tanstack/react-query';
import { healthApi } from '../api/endpoints';

export interface PveStatus {
  /** 是否已保存可用的连接（false = 首次部署还没填过，该去添加） */
  configured: boolean;
  /** 是否真的连上了 PVE（configured 为 true 时才可能有意义） */
  reachable: boolean;
  /** 首次探测还没回来 */
  loading: boolean;
  /**
   * 是否**真的探测到过结果**。
   *
   * 和 `configured` 的区别很关键：探测失败（后端没起来、面板正在重启）时
   * `configured` 会回落到默认的 true，但不能据此说「PVE 连不上」—— 那是把
   * 后端自己的故障算到 PVE 头上。判断「配了但连不上」必须要求 hasData 为真。
   */
  hasData: boolean;
}

export function usePveStatus(): PveStatus {
  const query = useQuery({
    queryKey: ['health'],
    queryFn: healthApi.check,
    refetchInterval: 30_000,
    retry: false,
  });

  /* 拿不到数据时（首屏加载中、后端刚重启、探测失败）一律当作「已配置」：
     宁可少提示一次，也不能因为一次探测失败就把「还没接入主机」的引导糊到
     所有人脸上 —— 那本身就是另一种「以为平台坏了」。 */
  const configured = query.data?.pve_configured ?? true;

  return {
    configured,
    reachable: query.data?.pve_connected ?? false,
    loading: query.isLoading,
    hasData: query.data !== undefined,
  };
}

/**
 * 给「依赖 PVE 的轮询」用：未配置连接时返回 false，让 `refetchInterval` 停下。
 *
 * 未配置时后端对每个请求都回 428，继续十秒一次只会刷一屏没人看的报错。配好之后
 * 这个值自动变回 true，轮询自己就接上了 —— 不需要用户刷新页面或重启面板。
 * 探测结果未知（首屏/探测失败）时返回 true：不能因为一次探测失败就把轮询关死。
 */
export function usePveReady(): boolean {
  return usePveStatus().configured;
}
