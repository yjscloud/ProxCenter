/* ==========================================================================
   pvecenter — 中文词条（类型聚合）
   --------------------------------------------------------------------------
   词条按加载时机拆分：
     · zh-CN.core.ts    —— 首屏与外壳，随主包；
     · zh-CN.app.ts     —— 后台共享词条，随任意后台页加载；
     · zh-CN.<domain>.ts —— 各业务域（compute / node / security / monitor /
                            settings / ai），随该域页面加载；
     · zh-CN.landing.ts —— 产品官网，随官网路由加载。
   这里只做类型聚合（import type 在编译期擦除，不会把数据拉回主包），
   `MessageKey` 仍是全量键的联合。
   ========================================================================== */

import type * as Core from './zh-CN.core';
import type * as App from './zh-CN.app';
import type * as Compute from './zh-CN.compute';
import type * as Node from './zh-CN.node';
import type * as Security from './zh-CN.security';
import type * as Monitor from './zh-CN.monitor';
import type * as Settings from './zh-CN.settings';
import type * as Ai from './zh-CN.ai';
import type * as Landing from './zh-CN.landing';

export type MessageKey =
  | keyof typeof Core.zhCore
  | keyof typeof App.zhApp
  | keyof typeof Compute.zhCompute
  | keyof typeof Node.zhNode
  | keyof typeof Security.zhSecurity
  | keyof typeof Monitor.zhMonitor
  | keyof typeof Settings.zhSettings
  | keyof typeof Ai.zhAi
  | keyof typeof Landing.zhLanding;
