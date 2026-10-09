/* ==========================================================================
   ProxCenter — AI 用量（token 消耗）弹窗

   入口是助手页标题栏的「Token 消耗」按钮。为什么用弹窗而不是页面里常驻一张
   卡片：助手页的主线是「选主机 → 跑一轮 → 看结论」，而用量是**事后回顾**的
   数据 —— 常驻卡片会在主线下面多出一块跟当前操作无关的内容，把页面拉长。
   弹窗是「想看的时候点开」，看完关掉，不占主线位置。

   数据来自 ``GET /api/ai/usage``，**业务口径全在后端**：总量、平均、按天分组、
   按模型分组都在那边算好 —— 两边各算一遍，迟早会出现「弹窗说 3.4k、记录页
   加起来是 3.1k」这种对不上的账。前端只做两件**展示层**的事：把 token 数格式化，
   以及把占比换算成百分比（呈现，不是口径）。

   视觉上沿用项目已有的语言，不另起一套：主读数用仪表盘的 KPI 卡
   （``.kpi-card`` / ``.kpi-value``），窗口切换用 ``SegmentedControl``，次级读数
   沿用「一个数值 + 一行标签」的统计行。``.ai-usage-*`` 只解决这个弹窗独有的
   两件事：**输入与输出的构成**要在同一根条上看出来，**每日趋势**要有等距时间轴
   （后端为此把窗口内每一天都补齐，见 ``aiaudit.usage_stats``）。
   ========================================================================== */

import { useState } from 'react';
import type { CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { aiApi } from '../api/endpoints';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { EmptyState, ErrorState } from './ui/EmptyState';
import { SegmentedControl } from './ui/Input';
import { formatNumber } from '../utils/format';
import { useT, type TFunc } from '../i18n';
import type { AiUsageDaily, AiUsageStats } from '../api/types';

/**
 * 可选回看窗口（天）。
 *
 * 三档而不是一条时间轴：1 天用来盯「今天花了多少」，7 天是日常默认，30 天看
 * 趋势。再细的粒度要配日期选择器，而这里的定位是「扫一眼」。
 *
 * 值用字符串是因为 ``SegmentedControl`` 的泛型约束是 ``string``（见 ui/Input）；
 * 发请求时再转回数字。
 */
const WINDOWS = ['1', '7', '30'] as const;
type Window = (typeof WINDOWS)[number];

function windowOptions(t: TFunc): Array<{ label: string; value: Window }> {
  return WINDOWS.map((days) => ({
    label: t('ai.usage.windowDays', { n: days }),
    value: days,
  }));
}

/**
 * 按模型条形图的色相。
 *
 * 每个模型一个色相，而不是全用品牌蓝：这张表本身就是「几个模型各占多少」的
 * 对比，条长已经表达了比例，颜色负责让上下两行**一眼分得开** —— 同色多条时，
 * 眼睛得顺着左边缘重新找行。这里只写色相，亮度与饱和度由样式里的 ``hsl()``
 * 统一给，免得六个色值各写一遍之后彼此不成调。
 */
const MODEL_HUES = [214, 190, 268, 160, 28, 330];

/** 占比百分比：整数就不带小数位（95%），否则留一位（5.2%）。 */
function shareText(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  const pct = Math.round((part / whole) * 1000) / 10;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

/** 轴上只写「月-日」：窗口首尾的完整日期由区块右上角交代。 */
function dayLabel(day: string): string {
  return day.length >= 10 ? day.slice(5) : day;
}

/** 耗时读数：1 秒以下给毫秒，10 秒以上不再留小数（免得把一行挤开）。 */
function msText(ms: number): string {
  if (ms <= 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

/**
 * 输入 / 输出占比条。
 *
 * 为什么要有它：这个弹窗里最容易被误读的一个数是「平均每次」—— 输入占了九成
 * 以上时，逐轮累积的历史上下文才是成本大头，而只看到总数的人会以为该去压输出。
 * 一根条把构成摊开，比再加一个数字有用。
 */
function SplitBar({ prompt, completion }: { prompt: number; completion: number }) {
  const t = useT();
  const whole = prompt + completion;
  return (
    <div className="ai-usage-split">
      <div
        className="ai-usage-split-track"
        role="img"
        aria-label={t('ai.usage.splitAria')}
      >
        {whole > 0 ? (
          <>
            <span
              className="ai-usage-split-seg is-prompt"
              style={{ width: `${(prompt / whole) * 100}%` }}
            />
            {/* 输出段用 flex:1 吃掉剩下的宽度：两段各自算百分比时，四舍五入
                会差出零点几个像素，末尾会露出一条缝 */}
            <span className="ai-usage-split-seg is-completion" />
          </>
        ) : null}
      </div>
      <div className="ai-usage-split-legend">
        <span className="ai-usage-legend-item is-prompt">
          <i className="ai-usage-legend-dot" />
          <span className="ai-usage-legend-label">
            {t('ai.usage.promptTokens')}
          </span>
          <b className="mono">{formatNumber(prompt)}</b>
        </span>
        <span className="ai-usage-legend-item is-completion">
          <i className="ai-usage-legend-dot" />
          <span className="ai-usage-legend-label">
            {t('ai.usage.completionTokens')}
          </span>
          <b className="mono">{formatNumber(completion)}</b>
        </span>
        <span className="ai-usage-legend-share mono">
          {shareText(prompt, whole)} / {shareText(completion, whole)}
        </span>
      </div>
    </div>
  );
}

/**
 * 每日消耗柱状图（纯 div，不引图表库）。
 *
 * 时间轴是**等距**的：后端把窗口内每一天都返回了（这天没跑就是 0），所以
 * 「这天没跑」与「这天不在窗口里」在图上分得开。空天不画柱子，只在基线上留
 * 一小截淡色轨道 —— 画一根 0 高度的柱子出来，看着像「跑了但没消耗」。
 */
function DailyChart({
  daily,
  label,
}: {
  daily: AiUsageDaily[];
  label: (row: AiUsageDaily) => string;
}) {
  const peak = Math.max(1, ...daily.map((row) => row.total_tokens));
  // 短窗口每天都标日期；长窗口按需稀疏，否则 30 个标签会糊成一条
  const dense = daily.length <= 10;
  const step = Math.max(1, Math.ceil(daily.length / 6));
  return (
    <div className="ai-usage-chart">
      {daily.map((row, idx) => {
        const idle = row.total_tokens === 0;
        const last = idx === daily.length - 1;
        const showDay = dense || last || idx === 0 || idx % step === 0;
        return (
          <div
            className={`ai-usage-col${idle ? ' is-idle' : ''}${
              last ? ' is-latest' : ''
            }`}
            key={row.day}
            title={label(row)}
          >
            <div className="ai-usage-col-field">
              <span className="ai-usage-col-tip mono">
                {formatNumber(row.total_tokens)}
              </span>
              <span
                className="ai-usage-col-bar"
                style={{
                  // 空天不走百分比：给一截固定的 3px 轨道。若照常算，
                  // Math.max 会把 0 抬成 3%，看着像「有消耗但很少」
                  height: idle
                    ? '3px'
                    : `${Math.max(3, Math.round((row.total_tokens / peak) * 100))}%`,
                }}
              />
            </div>
            <span className="ai-usage-col-day">
              {showDay ? dayLabel(row.day) : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** 一个次级读数（运行次数 / 平均每次 / …）。 */
function UsageStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="ai-usage-stat">
      <span className="ai-usage-stat-value mono">{value}</span>
      <span className="ai-usage-stat-label">{label}</span>
    </div>
  );
}

export function AiUsageModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const [days, setDays] = useState<Window>('7');

  const query = useQuery({
    queryKey: ['ai', 'usage', days],
    // 窗口值是字符串（SegmentedControl 的约束），发请求时转回数字
    queryFn: () => aiApi.usage({ days: Number(days) }),
    // 关着就不取数：弹窗是「想看才点开」的，没理由在页面加载时就打这一枪
    enabled: open,
    // 用量是事后数据，同一次打开里来回切窗口不必每次重取
    staleTime: 30_000,
  });

  const stats: AiUsageStats | undefined = query.data;
  const total = stats?.total;
  const runs = total?.runs ?? 0;
  const empty = !total || runs === 0;
  const models = stats?.by_model ?? [];
  const daily = stats?.daily ?? [];
  const peakModel = Math.max(1, ...models.map((row) => row.total_tokens));
  const windowDays = stats?.days ?? Number(days);

  return (
    // 描述跟着数据走：加载中说明这块是什么，有数据就把口径与规模直接讲出来
    // （「近 7 天 · 共 12 次运行」比一句泛泛的说明有用）
    <Modal
      open={open}
      onClose={onClose}
      className="ai-usage-modal"
      title={t('ai.usage.title')}
      description={
        query.isLoading
          ? t('ai.usage.modalDesc')
          : empty
            ? t('ai.usage.subtitleEmpty')
            : t('ai.usage.subtitle', { days: windowDays, runs })
      }
      size="lg"
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      {/* ---- 主读数：窗口切换、总数，以及输入 / 输出的构成 ---- */}
      <div className="kpi-card ai-usage-hero">
        <div className="kpi-top">
          <span className="kpi-label">{t('ai.usage.totalTokens')}</span>
          <SegmentedControl<Window>
            value={days}
            onChange={setDays}
            ariaLabel={t('ai.usage.windowLabel')}
            options={windowOptions(t)}
          />
        </div>
        {query.isLoading ? (
          <span
            className="skeleton skeleton-text"
            style={{ width: 168, height: 32 }}
          />
        ) : (
          <>
            <span className="kpi-value">
              {formatNumber(empty ? 0 : total.total_tokens)}
            </span>
            {/* 单位与口径放在 hint 里而不是拼进数字：.kpi-value 走的是
                background-clip:text 的渐变填充，里面的子元素会被一起裁成透明。 */}
            <span className="kpi-hint">
              {t('ai.usage.unit')} · {t('ai.usage.heroCaption', { days: windowDays })}
            </span>
            {empty ? null : (
              <SplitBar
                prompt={total.prompt_tokens}
                completion={total.completion_tokens}
              />
            )}
          </>
        )}
      </div>

      {query.isLoading ? (
        <div className="ai-usage-stats">
          {[0, 1, 2, 3].map((idx) => (
            <div className="ai-usage-stat" key={idx}>
              <span
                className="skeleton skeleton-text"
                style={{ width: 56, height: 18 }}
              />
              <span
                className="skeleton skeleton-text"
                style={{ width: 40, height: 12 }}
              />
            </div>
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState
          title={t('ai.usage.loadFailed')}
          message={t('ai.usage.loadFailedMsg')}
        />
      ) : empty ? (
        <EmptyState
          title={t('ai.usage.noData')}
          description={t('ai.usage.noDataDesc', { n: windowDays })}
          compact
        />
      ) : (
        <>
          {/* 输入 / 输出在上面那根条里已经给过绝对数字，这里只放另外四个读数 ——
              同一行里不重复显示同一个数 */}
          <div className="ai-usage-stats">
            <UsageStat value={formatNumber(runs)} label={t('ai.usage.runs')} />
            <UsageStat
              value={formatNumber(total.avg_tokens)}
              label={t('ai.usage.avgTokens')}
            />
            <UsageStat
              value={formatNumber(total.tool_calls)}
              label={t('ai.usage.toolCalls')}
            />
            <UsageStat
              value={msText(total.avg_duration_ms)}
              label={t('ai.usage.avgDuration')}
            />
          </div>

          {daily.length > 1 ? (
            <section className="ai-usage-section">
              <header className="ai-usage-section-head">
                <span className="ai-usage-section-title">{t('ai.usage.trend')}</span>
                <span className="fs-xs text-muted">
                  {daily[0]?.day} → {daily[daily.length - 1]?.day}
                </span>
              </header>
              <DailyChart
                daily={daily}
                label={(row) =>
                  t('ai.usage.dayTip', { day: row.day, n: row.total_tokens })
                }
              />
            </section>
          ) : null}

          {models.length > 0 ? (
            <section className="ai-usage-section">
              <header className="ai-usage-section-head">
                <span className="ai-usage-section-title">{t('ai.usage.byModel')}</span>
              </header>
              <div className="ai-usage-models">
                {models.map((row, idx) => (
                  <div
                    className="ai-usage-model"
                    key={`${row.provider}/${row.model}`}
                    style={
                      {
                        '--m-hue': MODEL_HUES[idx % MODEL_HUES.length],
                      } as CSSProperties
                    }
                  >
                    <span className="ai-usage-model-dot" />
                    <span className="ai-usage-model-name" title={row.provider}>
                      {row.model || t('ai.usage.unknownModel')}
                    </span>
                    {/* 比例条相对**最大的那个模型**，不是相对总量：几个小模型并列
                        时相对总量的条会全部短到看不见，比不出谁多谁少。
                        百分比则相对总量 —— 它回答的是「这个模型吃掉了多少成本」。 */}
                    <span className="ai-usage-model-track">
                      <span
                        className="ai-usage-model-fill"
                        style={{
                          width: `${Math.max(
                            3,
                            Math.round((row.total_tokens / peakModel) * 100),
                          )}%`,
                        }}
                      />
                    </span>
                    <span className="ai-usage-model-share mono">
                      {shareText(row.total_tokens, total.total_tokens)}
                    </span>
                    <span className="ai-usage-model-value mono">
                      {formatNumber(row.total_tokens)}
                    </span>
                    <span className="ai-usage-model-runs">
                      {t('ai.usage.runsUnit', { n: row.runs })}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
    </Modal>
  );
}
