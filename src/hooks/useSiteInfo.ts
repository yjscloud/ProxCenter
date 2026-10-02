/* ==========================================================================
   ProxCenter — 站点信息
   品牌名 / 副标题 / 版权 / 备案号 / 友情链接 / 自定义 Logo，
   由后端 settings 表提供，可在「设置 → 站点信息」中修改。
   ========================================================================== */

import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { siteApi } from '../api/endpoints';
import { useT } from '../i18n';
import type { SiteInfo } from '../api/types';

/**
 * 后端不可用时的兜底值：与后端 site.py 的内置默认值保持一致，
 * 保证接口失败时界面仍显示完整的品牌信息，而不是空白标题。
 * 备案号与友链的默认值都是「空」，即不展示。
 *
 * 副标题与版权留空：它们的默认文案要随界面语言变，由 useSiteInfo()
 * 在运行时用词条补齐（模块级常量拿不到当前语言）。
 */
export const DEFAULT_SITE_INFO: SiteInfo = {
  name: 'ProxCenter',
  subtitle: '',
  copyright: '',
  icp: '',
  links: [],
  logo_url: null,
  login_bg_url: null,
};

export function useSiteInfo(): SiteInfo {
  const t = useT();
  const query = useQuery({
    queryKey: ['config', 'site'],
    queryFn: siteApi.get,
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const info = query.data ?? DEFAULT_SITE_INFO;

  const resolved = useMemo<SiteInfo>(
    () => ({
      ...info,
      subtitle: info.subtitle || t('site.defaultSubtitle'),
      copyright: info.copyright || t('site.defaultCopyright'),
    }),
    [info, t],
  );

  /* 浏览器标题跟随站点名：放在这里，登录页与落地页也能生效 */
  useEffect(() => {
    document.title = t('site.documentTitle', { name: resolved.name });
  }, [resolved.name, t]);

  /* 上传了自定义 Logo 就一并用作浏览器标签页图标 */
  useEffect(() => {
    if (!info.logo_url) return;
    let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = info.logo_url;
  }, [info.logo_url]);

  return resolved;
}
