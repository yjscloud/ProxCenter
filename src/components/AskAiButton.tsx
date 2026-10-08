/* ==========================================================================
   ProxCenter — 「问 AI」入口

   把「在某个页面发现问题」到「去 AI 助手把问题描述一遍」之间那段手工搬运去掉：
   跳转时带上 `?host=` 与 `?question=`，落地后问题已经在输入框里，直接回车就行。

   为什么用 query 参数而不是路由 state：
   用户很可能刷新一下再问、或者把链接存下来 —— 参数在地址栏里，这些场景都成立；
   路由 state 一刷新就没了，用户会面对一个空白的输入框发呆。
   ========================================================================== */

import { useNavigate } from 'react-router-dom';
import { IconSparkle } from './Icons';
import { Button } from './ui/Button';
import { useT } from '../i18n';

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

  // 面板本机**不是**助手的目标（见后端 ai.ai_targets：那是跑着面板、握着全部
  // 凭据的那台机器，不该从助手这条更放权的路径进来）。这里直接不渲染，而不是
  // 让它跳过去 —— 跳过去只会落到「请先确认要排查哪台机器」上，用户大概率随手
  // 选一台受管主机，而那台机器根本不是他刚才在看的那台。
  if (hostId === 'local') return null;

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
