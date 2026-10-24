/* ==========================================================================
   ProxCenter — 「问 AI」入口

   把「在某个页面发现问题」到「去 AI 助手把问题描述一遍」之间那段手工搬运去掉：
   跳转时带上 `?host=` 与 `?question=`，落地后问题已经在输入框里，直接回车就行。

   为什么用 query 参数而不是路由 state：
   用户很可能刷新一下再问、或者把链接存下来 —— 参数在地址栏里，这些场景都成立；
   路由 state 一刷新就没了，用户会面对一个空白的输入框发呆。
   ========================================================================== */

import { useNavigate } from 'react-router';
import { IconSparkle } from './Icons';
import { Button } from './ui/Button';
import { useT } from '../i18n';
import { useAuth } from '../hooks/useAuth';
import { useUiPrefs } from '../hooks/useUiPrefs';
import { AI_ASSISTANT_NAV_PATH, isPathDisabled } from './Sidebar';

/**
 * 使用「AI 排查助手」所需的权限。
 *
 * 必须与路由守卫和侧边栏用同一把钥匙（见 App.tsx 的 /ai-assistant、
 * Sidebar 的 nav.aiAssistant）。没有它的人点进去只会被守卫弹回仪表盘 ——
 * 那等于在各页面里摆了一堆走不通的按钮，所以入口本身要按它隐藏。
 */
export const AI_ASSISTANT_PERMISSION = 'baseline.view';

/**
 * 「问 AI」入口现在能不能用：**权限**与**面板级开关**两件事都得成立。
 *
 * 缺任何一件，按钮点下去都走不通 —— 没权限的被路由守卫弹回仪表盘；入口被管理员
 * 在「设置 → 导航栏功能开关」里关掉的，守卫同样会拦（isPathDisabled 与侧边栏、
 * 顶栏、命令面板用的是同一套判定）。
 *
 * 判定收在这一处：所有「问 AI」按钮（虚拟机详情、SSH 安全、安全基线、端口与
 * 进程、登录审计……）以及虚拟机列表行菜单里的那一项都从这里取答案，别再各页面
 * 自己拼条件 —— 拼漏一处就会出现「导航里关了、某个页面还摆着按钮」。
 */
export function useAiAssistantEntry(): boolean {
  const { hasPermission } = useAuth();
  const navDisabled = useUiPrefs().nav_disabled;
  return (
    hasPermission(AI_ASSISTANT_PERMISSION) &&
    !isPathDisabled(AI_ASSISTANT_NAV_PATH, navDisabled)
  );
}

export function AskAiButton({
  hostId,
  question,
  preset,
  size = 'sm',
  variant = 'ghost',
  label,
  title,
}: {
  /** 目标主机：受管主机 id。不传则到助手页由用户自己选 */
  hostId?: string;
  /** 预填的问题；留空则只切主机 */
  question?: string;
  /** 直接跑某个预案（见后端 aiplaybooks），与 question 二选一 */
  preset?: string;
  size?: 'sm' | 'md';
  variant?: 'ghost' | 'secondary' | 'primary';
  label?: string;
  title?: string;
}) {
  const t = useT();
  const navigate = useNavigate();
  const aiAvailable = useAiAssistantEntry();

  // 面板本机**不是**助手的目标（见后端 ai.ai_targets：那是跑着面板、握着全部
  // 凭据的那台机器，不该从助手这条更放权的路径进来）。这里直接不渲染，而不是
  // 让它跳过去 —— 跳过去只会落到「请先确认要排查哪台机器」上，用户大概率随手
  // 选一台受管主机，而那台机器根本不是他刚才在看的那台。
  if (hostId === 'local') return null;

  // 没被授予 AI 排查助手权限、或这个入口已被面板级开关关掉：按钮不出现
  //（与「面板本机」同理，摆着也走不通 —— 见 useAiAssistantEntry）
  if (!aiAvailable) return null;

  return (
    <Button
      variant={variant}
      size={size}
      icon={<IconSparkle size={15} />}
      title={title ?? t('ai.askAiHint')}
      onClick={() => {
        const params = new URLSearchParams();
        if (hostId) params.set('host', hostId);
        if (question) params.set('question', question);
        if (preset) params.set('preset', preset);
        const qs = params.toString();
        navigate(`/ai-assistant${qs ? `?${qs}` : ''}`);
      }}
    >
      {label ?? t('ai.askAi')}
    </Button>
  );
}
