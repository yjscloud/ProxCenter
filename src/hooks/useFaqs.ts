/* ==========================================================================
   ProxCenter — 常见问题（产品官网 FAQ 区块）
   内容由后端 settings 表提供，可在「设置 → 常见问题」中增删改。
   ========================================================================== */

import { useQuery } from '@tanstack/react-query';
import { faqApi } from '../api/endpoints';
import type { FaqItem } from '../api/types';

/**
 * 兜底问题：与后端 faq.py 的内置默认值保持一致，保证后端不可用时官网
 * 仍有完整的 FAQ 内容。
 *
 * 注意这里和站点信息不同 —— 对 FAQ 来说**空数组是合法状态**（管理员主动
 * 关掉了这个区块），所以接口失败时用默认值兜底，而不是回落到空数组，
 * 否则一次网络抖动就会让 FAQ 整块消失。
 */
export const DEFAULT_FAQS: FaqItem[] = [
  {
    q: '需要把 Proxmox 暴露到公网吗？',
    a: '不需要。面板在内网通过 Proxmox API（默认 8006）访问集群，只有面板自身需要对外提供访问入口。',
  },
  {
    q: '为什么浏览器控制台还需要额外填一个 Proxmox 账号？',
    a: 'Proxmox 不允许 API Token 调用 vncproxy / termproxy，控制台只认用户名密码换取的 ticket。该功能可选，不填不影响其它功能。',
  },
  {
    q: 'SSL 证书「自动续期」是怎么工作的？',
    a: '以腾讯云免费 DV 证书为例：证书有效期 90 天，面板会按你设定的天数（默认到期前 15 天）自动提交续期申请，等 CA 签发成功后自动下载并重新部署到目标机器，最后执行你配置的重载命令（如 nginx -s reload）。',
  },
  {
    q: '飞书机器人需要公网回调吗？会不会被人乱操作？',
    a: '需要：机器人通过飞书开放平台的事件回调访问面板，回调地址必须能被飞书访问到（内网部署可用反向代理或内网穿透）。安全上做了两层限制：一是必须配置群会话或用户白名单，名单外的消息一律拒绝；二是关机、重启、回滚这类危险操作会先弹确认卡片，点确认才执行，全过程写入审计日志。',
  },
];

export function useFaqs(): FaqItem[] {
  const query = useQuery({
    queryKey: ['config', 'faq'],
    queryFn: faqApi.get,
    staleTime: 5 * 60_000,
    retry: 1,
  });

  return query.data ?? DEFAULT_FAQS;
}
