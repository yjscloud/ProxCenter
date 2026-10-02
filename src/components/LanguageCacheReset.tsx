/* ==========================================================================
   ProxCenter — 切换语言后让查询缓存失效

   不少接口的文案是**后端**按 `Accept-Language` 本地化的：后台作业的名称 /
   分组 / 说明 / 摘要、权限目录、内置角色名、内置 FAQ 默认值……而这些请求的
   queryKey 里并不含语言。切换语言时 react-query 会把缓存里的「上一语言」数据
   直接交给界面，表现就是「页面框架已经是英文，列表里却还是中文」。

   这里在语言变化时把所有查询标记为过期：已挂载的下一次渲染就在后台重取，
   未挂载的下次访问时重取。用 invalidateQueries 而不是 clear()：旧数据会保留
   到新数据到达，界面不会闪一下空白。
   ========================================================================== */

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../i18n';

export function LanguageCacheReset() {
  const { lang } = useI18n();
  const queryClient = useQueryClient();
  /* 用「首次渲染时的语言」做基准而不是布尔标记：StrictMode 下 effect 会跑两次，
     布尔标记在第二次就会误判成「语言变了」 */
  const initialLang = useRef(lang);

  useEffect(() => {
    if (initialLang.current === lang) return;
    void queryClient.invalidateQueries();
  }, [lang, queryClient]);

  return null;
}
