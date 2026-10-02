/* ==========================================================================
   ProxCenter — 常见问题（产品官网 FAQ 区块）
   内容由后端 settings 表提供，可在「设置 → 常见问题」中增删改。
   ========================================================================== */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { faqApi } from '../api/endpoints';
import { useT, type TFunc } from '../i18n';
import type { FaqItem } from '../api/types';

/**
 * 兜底问题：与后端 faq.py 的内置默认值保持一致，保证后端不可用时官网
 * 仍有完整的 FAQ 内容。
 *
 * 注意这里和站点信息不同 —— 对 FAQ 来说**空数组是合法状态**（管理员主动
 * 关掉了这个区块），所以接口失败时用默认值兜底，而不是回落到空数组，
 * 否则一次网络抖动就会让 FAQ 整块消失。
 *
 * 文案含中文，因此做成接收 t 的工厂函数（模块级常量拿不到当前语言）。
 */
function defaultFaqs(t: TFunc): FaqItem[] {
  return [
    { q: t('faq.q1'), a: t('faq.a1') },
    { q: t('faq.q2'), a: t('faq.a2') },
    { q: t('faq.q3'), a: t('faq.a3') },
    { q: t('faq.q4'), a: t('faq.a4') },
  ];
}

export function useFaqs(): FaqItem[] {
  const t = useT();
  const query = useQuery({
    queryKey: ['config', 'faq'],
    queryFn: faqApi.get,
    staleTime: 5 * 60_000,
    retry: 1,
  });

  return useMemo(() => query.data ?? defaultFaqs(t), [query.data, t]);
}
