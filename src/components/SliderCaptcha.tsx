/* ==========================================================================
   ProxCenter — 滑动验证（把滑块推到最右端）
   ==========================================================================

   外观与交互回到最初那一版：一条通栏轨道，左侧一块白色手柄（「»」图标），
   拖到右端后手柄变绿打勾，轨道下方提示「已拖到底 / 可以登录了」。
   没有蓝色竖标、没有对准中心线的要求 —— 那两样在实测里反而让人不知道该
   拖到哪里（见下方「为什么退回」）。

   为什么退回「拖到底」：

   · v4 把随机目标画成轨道上的蓝色竖标，让用户对准。反馈是「不知道该拖到
     哪」「拖过去了也不确定对没对上」，而且手柄会把竖标盖住。可用性优先。
   · 判定回到 `x >= 右端点 - 容差`，前端因此**可以在本地判断是否已到位**，
     于是又能给出「已拖到底」的即时反馈（v4 只能等服务端裁决）。

   退回样式不等于退回防护。仍然保留轨迹上报：拖动过程中的采样点（x + 毫秒
   时间戳）随位置一起交上去，服务端要看到「多个递增采样点 + 合理耗时」才
   认。只交一个坐标的脚本（H-1 的复现方式）照样被拒 —— 这一点对用户不可见。

   三个实现细节沿用旧版：

   · **几何全部按比例算，不写死像素。** 登录卡在窄屏只有 296px 宽，轨道钉死
     320px 会溢出，所以宽度 100%、手柄宽度与位移都用百分比，指针位移再按
     「设计坐标 / 实际渲染宽度」换算回设计坐标 —— 上报的位置必须与后端算出的
     阈值同尺度。
   · **键盘可达靠一个透明的原生 range**，鼠标行为自己实现：原生 range 一按下
     就会让拇指跳到点击处，等于「点一下」就跳过验证。这里 input 设
     pointer-events: none，只留 Tab + 方向键。
   · **位置用 ref 往上报，不走 state**：拖动中每移动 1px 都触发回调，上层用
     state 接会把登录表单重渲染一遍。

   换题（challenge.id 变化）会把位置与轨迹一起归零：新题与上一题无关，不归零
   就会出现「滑块停在上一次的落点、看起来已经拖到底」的假象。
   ========================================================================== */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { IconCheck, IconChevronRight } from './Icons';
import { useT } from '../i18n';
import type { CaptchaChallenge, SliderTracePoint } from '../api/types';

/** 服务端要求的最少采样点（见 backend/app/captcha.py 的 SLIDER_PATH_MIN_POINTS） */
const MIN_TRACE_POINTS = 5;
/** 补齐轨迹时假设的最短拖动耗时（ms），与服务端的 SLIDER_MIN_MS 对齐 */
const MIN_ELAPSED_MS = 200;
/** 服务端接受的拖动耗时上限（ms），与服务端的 SLIDER_MAX_MS 对齐 */
const MAX_ELAPSED_MS = 30_000;

/**
 * 轨迹不足时按首末位置线性补齐。
 *
 * 只有键盘操作（方向键一下一下按）和极快的拖动会走到这里 —— 真实指针拖动
 * 每秒会产生几十个 pointermove。补齐是为了不让无障碍路径被服务端直接判负。
 */
function padTrace(
  trace: SliderTracePoint[],
  x: number,
  elapsed: number,
): SliderTracePoint[] {
  if (trace.length >= MIN_TRACE_POINTS) return trace.slice();
  const total = Math.max(MIN_ELAPSED_MS, Math.round(elapsed));
  const from = trace.length > 0 ? trace[0].x : 0;
  const out: SliderTracePoint[] = [];
  for (let i = 0; i < MIN_TRACE_POINTS; i += 1) {
    const ratio = i / (MIN_TRACE_POINTS - 1);
    out.push({
      x: Math.round(from + (x - from) * ratio),
      t: Math.round(total * ratio),
    });
  }
  return out;
}

export interface SliderCaptchaProps {
  challenge: CaptchaChallenge;
  /**
   * 位置变化：设计坐标 px（0 = 未拖动）+ 截止当前的轨迹采样点。
   * 上层用 ref 接收即可，不必触发渲染。
   */
  onPosition: (x: number, path: SliderTracePoint[]) => void;
  /** 换一道题 */
  onRefresh: () => void;
  loading?: boolean;
  disabled?: boolean;
  /** 字段级错误：显示在轨道下方，并给轨道加红边 */
  error?: string;
}

export function SliderCaptcha({
  challenge,
  onPosition,
  onRefresh,
  loading = false,
  disabled = false,
  error,
}: SliderCaptchaProps) {
  const t = useT();
  const width = challenge.width ?? 320;
  const handleSize = challenge.handle_size ?? 56;
  const tolerance = challenge.tolerance ?? 6;
  /* 可拖动范围：手柄右缘贴住轨道右缘时的位移 */
  const maxOffset = Math.max(0, width - handleSize);

  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);

  const trackRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /* 轨迹采样点：按下时清空，移动时追加（同一位置不重复记点） */
  const traceRef = useRef<SliderTracePoint[]>([]);
  /* 起手时刻（performance.now），用于给采样点打时间戳 */
  const startedAtRef = useRef(0);
  /* 拖动起手信息：按下点、当时的偏移、以及渲染像素 → 设计坐标的换算比 */
  const dragRef = useRef<{ startX: number; startOffset: number; scale: number } | null>(
    null,
  );

  /* 已经算「拖到底」：提前把图标换成对勾，让人知道可以点登录了
     （真正的判定在服务端，这里只是同一套阈值的视觉反馈） */
  const reached = offset >= maxOffset - tolerance && offset > 0;

  /* 位置与轨迹一起抛给上层：服务端要的是「拖到哪 + 怎么拖过去的」 */
  const emit = useCallback(
    (x: number, elapsed: number) => {
      onPosition(x, padTrace(traceRef.current, x, elapsed));
    },
    [onPosition],
  );

  const set = useCallback(
    (value: number) => {
      const clamped = Math.min(maxOffset, Math.max(0, Math.round(value)));
      /* 停留太久再动手（尤其是键盘）：轨迹跨度会超出服务端上限，重置计时 */
      if (performance.now() - startedAtRef.current > MAX_ELAPSED_MS) {
        startedAtRef.current = performance.now();
        traceRef.current = [];
      }
      const now = Math.max(0, Math.round(performance.now() - startedAtRef.current));
      const trace = traceRef.current;
      const last = trace[trace.length - 1];
      if (!last || last.x !== clamped) trace.push({ x: clamped, t: now });
      setOffset(clamped);
      emit(clamped, now);
    },
    [maxOffset, emit],
  );

  useEffect(() => {
    setOffset(0);
    dragRef.current = null;
    traceRef.current = [];
    startedAtRef.current = performance.now();
    onPosition(0, []);
    // onPosition 由上层用 useCallback 固定，不会导致重复归零
  }, [challenge.id, onPosition]);

  /* 校验失败后把滑块弹回起点：停在原位会让人以为「位置没问题、只是按钮点错了」，
     实际上服务端说的是「这次没过，重拖一次」。 */
  useEffect(() => {
    if (!error) return;
    setOffset(0);
    dragRef.current = null;
    traceRef.current = [];
    onPosition(0, []);
  }, [error, onPosition]);

  const interactive = !disabled && !loading;

  const onHandleDown = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!interactive) return;
    // 指针捕获：滑出轨道后仍能继续拖，松手也一定能收到事件。
    // 捕获失败不该让整次拖动作废（合成事件、老版 Safari 都会抛 NotFoundError）。
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* 没有可捕获的指针：退化成普通拖动，不影响判定 */
    }
    const rect = trackRef.current?.getBoundingClientRect();
    startedAtRef.current = performance.now();
    /* 起点也记一个采样点：服务端要判「整体单调向右」，缺了起点无法判断 */
    traceRef.current = [{ x: offset, t: 0 }];
    dragRef.current = {
      startX: event.clientX,
      startOffset: offset,
      scale: rect && rect.width > 0 ? width / rect.width : 1,
    };
    setDragging(true);
    // 点手柄时把焦点交给透明 range，拖完可以直接用方向键微调
    inputRef.current?.focus({ preventScroll: true });
  };

  const onHandleMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    set(drag.startOffset + (event.clientX - drag.startX) * drag.scale);
  };

  const onHandleUp = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      /* 同上：释放失败不影响结果 */
    }
    // 松手时已经很接近末端：直接吸附到尽头。
    // 最后几像素手指很难停准，不吸附就会出现「明明推到头了却没通过」。
    // set() 负责补上末点采样并上报，末点必须等于提交的位置（服务端会核对）。
    set(offset >= maxOffset - tolerance ? maxOffset : offset);
  };

  return (
    <div className="slider-captcha">
      <div
        ref={trackRef}
        className={`slider-track${reached ? ' is-moved' : ''}${
          dragging ? ' is-dragging' : ''
        }${error ? ' has-error' : ''}`}
      >
        <span
          className="slider-track-fill"
          style={{ width: `${((offset + handleSize) / width) * 100}%` }}
          aria-hidden="true"
        />
        {/* 提示只在「还没拖」的时候显示：拖过之后手柄会停在轨道中间，
            正中央的文字会被它压成两截。 */}
        <span className="slider-track-hint" aria-hidden="true">
          {offset > 0 ? '' : t('captcha.dragHint')}
        </span>

        <span
          className="slider-handle"
          style={{
            width: `${(handleSize / width) * 100}%`,
            /* 位移按手柄自身宽度的百分比给：轨道整体缩放时不需要重算 */
            transform: `translateX(${(offset / handleSize) * 100}%)`,
          }}
          role="presentation"
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
        >
          {reached ? (
            <IconCheck size={16} />
          ) : (
            /* 双箭头「»」：与参考图一致，也暗示「往右拖」 */
            <span className="slider-handle-arrows" aria-hidden="true">
              <IconChevronRight size={15} />
              <IconChevronRight size={15} />
            </span>
          )}
        </span>

        {/* 透明原生 range：只承担键盘操作与无障碍语义，不接指针事件 */}
        <input
          ref={inputRef}
          className="slider-input"
          type="range"
          min={0}
          max={maxOffset}
          step={1}
          value={offset}
          disabled={!interactive}
          aria-label={t('captcha.dragAria')}
          aria-valuetext={
            reached
              ? t('captcha.reached')
              : offset > 0
                ? t('captcha.movedTo', { n: offset })
                : t('captcha.notMoved')
          }
          onChange={(event) => set(Number(event.target.value))}
        />
      </div>

      {/* 错误与「已就绪」共用同一个位置：两者互斥，不会同时出现 */}
      {error ? (
        <div className="slider-captcha-error" role="alert">
          {error}
          <button type="button" className="slider-captcha-retry" onClick={onRefresh}>
            {t('captcha.retry')}
          </button>
        </div>
      ) : reached ? (
        <div className="slider-captcha-ok">{t('captcha.ok')}</div>
      ) : null}
    </div>
  );
}
