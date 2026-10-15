/* ==========================================================================
   ProxCenter — 顶栏「集群作用域」
   ==========================================================================

   面板把多条 PVE 连接当同级：默认「全部集群」时，节点 / 虚拟机 / 存储这些列表
   接口会合并全部连接；聚焦到某一条时，只读那一套。

   为什么摆在顶栏而不是某一页：它影响的是**所有页面**的读数范围。摆在节点页时
   （原先的「默认读取的 PVE」）它只影响少数单台接口，看起来像个没人说得清的主控；
   提升为全局作用域之后，「我现在看的是哪一套集群」必须随时可见、可切。

   三份存储，各司其职（见 api/scope.ts 与后端 app/prefs.py）：

   * **URL** ``?scope=<id>`` —— 当前这一条地址里的选择。分享出去的链接会自带
     「我在看哪套集群」，浏览器后退也能回到上一套。优先级最高，且**不改写**你保存的
     偏好 —— 别人分享给你的链接只是「这次看这套」，你自己的默认仍然留在服务端；
   * **localStorage** —— 本设备的热副本。请求拦截器与「启动前校验」都要**同步**
     读它，所以它必须在内存/本地，不能等服务端返回；
   * **服务端偏好**（``cluster_scope``）—— 跟着账号走，换设备 / 换浏览器能恢复。
     页面加载时若 URL 没指定，就以它为准（本设备那份只是上次留下的缓存）。

   跟随它的（「资源」口径）：节点 / 虚拟机 / 存储 / 任务的列表，以及仪表盘的
   用量榜单与容量预测 —— 聚焦一套时看的就是那一套。

   不跟随的（「机队健康」口径）：顶栏控制台状态、设置页系统信息、仪表盘的
   「集群态势」。它们回答的是「一共几套、几台、谁失去仲裁」，随作用域缩水反而会
   把异常藏起来（后端 fleet-status 压根不看这个头）。这一点写在选择器的 title 里，
   免得被误解成「切了作用域就只看一台」。
   ========================================================================== */

import { useEffect, useRef, type ChangeEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { connectionsApi, prefsApi } from '../api/endpoints';
import {
  SCOPE_PREF_KEY,
  rememberConnections,
  setGlobalScope,
} from '../api/scope';
import { useGlobalScope } from '../hooks/useGlobalScope';
import { useAuth } from '../hooks/useAuth';
import { IconLayers } from './Icons';
import { useT } from '../i18n';

export function ScopeSelect() {
  const t = useT();
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  /* 当前值直接订阅模块级作用域：本组件是它的唯一编辑入口，
     读同一份能避免两份 state 走神 */
  const scope = useGlobalScope();
  /* 服务端偏好只采纳一次：之后以用户在本设备上的选择为准，
     否则每次偏好被重新拉回都会把用户刚切的作用域顶回去 */
  const adoptedPrefRef = useRef(false);

  /* 连接列表：与节点页 / 连接管理 / 设置页共用同一份缓存（queryKey 一致）。
     普通用户拿到的是精简版（只有 id / 名称 / 区域），够用来选。 */
  const connectionsQuery = useQuery({
    queryKey: ['connections'],
    queryFn: connectionsApi.list,
    staleTime: 300_000,
    retry: false,
  });
  const conns = connectionsQuery.data ?? [];
  /* 只有一套 PVE 时没有「看哪一套」的问题，连偏好都不必读 */
  const multi = conns.length >= 2;

  /* 服务端那份作用域（换设备恢复用）。与仪表盘布局各拉一次 /prefs —— 那是很小的
     一份 JSON，而把两个 hook 收到同一个 query 里会让布局那边的局部状态耦合进来。 */
  const prefsQuery = useQuery({
    queryKey: ['prefs'],
    queryFn: prefsApi.list,
    staleTime: 300_000,
    enabled: multi,
  });

  const urlScope = searchParams.get('scope');

  /* 1) 把这份连接列表交给作用域模块做两件事（见 api/scope.ts）：
        记下 id，供**下次启动**在发第一批请求之前就判断作用域还有没有效 ——
        否则连接被删后首屏会先闪一片「连接不存在」，等列表回来才自愈；
        顺便当场纠正：作用域指向的连接已经不在了就清掉。 */
  useEffect(() => {
    if (!connectionsQuery.data) return;
    const ids = connectionsQuery.data
      .map((item) => item.id)
      .filter((id): id is string => Boolean(id));
    if (rememberConnections(ids)) {
      void queryClient.invalidateQueries();
    }
  }, [connectionsQuery.data, queryClient]);

  /* 2) URL 上的 ?scope= 优先：分享链接带着它打开、浏览器后退回到上一套，
        都走这里。无效的 id 直接忽略（不拿它去打请求）。 */
  useEffect(() => {
    if (urlScope === null || !conns.length) return;
    if (urlScope && !conns.some((item) => item.id === urlScope)) return;
    if (urlScope === scope) return;
    setGlobalScope(urlScope);
    void queryClient.invalidateQueries();
  }, [urlScope, conns, scope, queryClient]);

  /* 3) URL 没指定时以服务端偏好为准（换设备 / 换浏览器恢复视角）。
        等连接列表到齐再采纳：要先确认存的 id 还有效。 */
  useEffect(() => {
    if (adoptedPrefRef.current) return;
    const payload = prefsQuery.data;
    if (!payload || !conns.length) return;
    adoptedPrefRef.current = true;
    if (urlScope !== null) return;
    const saved = payload.prefs?.[SCOPE_PREF_KEY];
    if (typeof saved !== 'string' || saved === scope) return;
    if (saved && !conns.some((item) => item.id === saved)) return;
    setGlobalScope(saved);
    void queryClient.invalidateQueries();
  }, [prefsQuery.data, conns, urlScope, scope, queryClient]);

  /* 同样只在「有多套 PVE」时才有意义；普通用户再看一层：切换集群是运维视角，
     不给他们展示。注意这个早返回在几个 effect **之后** —— 副作用照常生效，
     免得普通用户打开带 ?scope= 的分享链接时，作用域不会被采纳。 */
  if (!multi || !isAdmin) return null;

  const choose = (next: string) => {
    if (next === scope) return;
    setGlobalScope(next);
    /* URL 也落一份。函数式更新保住页面自己的查询参数（筛选、分页…）；
       replace: false —— 切作用域是一步可回退的操作，后退键应该能退回去。 */
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        if (next) params.set('scope', next);
        else params.delete('scope');
        return params;
      },
      { replace: false },
    );
    /* 服务端偏好：换设备打开时能恢复。写失败不影响本次切换（本地那份已经生效）。 */
    void prefsApi.save(SCOPE_PREF_KEY, next).catch(() => undefined);
    /* 全量失效：作用域进了请求头，所有带连接语义的读数都要重取。
       invalidateQueries 会把**未挂载**的查询也标成失效（isInvalidated 优先于
       staleTime），所以切到别的页面时不会读到上一套集群的旧数据。 */
    void queryClient.invalidateQueries();
  };

  return (
    <label className="scope-select is-topbar" title={t('scope.title')}>
      <IconLayers size={15} />
      <select
        value={scope}
        aria-label={t('scope.label')}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => choose(event.target.value)}
      >
        <option value="">{t('scope.all')}</option>
        {conns.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name || item.host || item.id}
          </option>
        ))}
      </select>
    </label>
  );
}
