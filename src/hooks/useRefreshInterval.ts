/* ==========================================================================
   ProxCenter — 「数据刷新间隔」取值

   把「设置 → 面板设置 → 数据刷新间隔」交给需要的查询：

     const refresh = useRefreshInterval();
     useQuery({ ..., refetchInterval: pveReady ? refresh : false });

   它返回毫秒数，或在用户选择「不自动刷新」时返回 `false`。

   两种「不跟这个设置」的情况（都是刻意为之，别再逐处改成跟随）：

     * **盯一个过程**的轮询：导入进度、重装进度、更新进度、运行中任务的日志
       回填。它们的节奏由那个过程本身决定，与「多久刷一次数据」不是一件事；
     * **代价很高的一次探测**：如首页工作台逐台探活连接（见 Workbench），
       跟到这个间隔会把 PVE 打满。

   设置页保存后会在窗口上派发事件，这里据此立即改用新值 —— 顶栏、通知铃铛
   这些组件切页时并不卸载，不通知就会一直按老节奏跑。
   ========================================================================== */

import { useEffect, useState } from 'react';
import { SETTINGS_CHANGED_EVENT, panelRefreshMs } from '../utils/panelSettings';

export function useRefreshInterval(): number | false {
  const [ms, setMs] = useState(panelRefreshMs);

  useEffect(() => {
    const onChanged = () => setMs(panelRefreshMs());
    window.addEventListener(SETTINGS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, onChanged);
  }, []);

  return ms;
}
