/* ==========================================================================
   ProxCenter — 滑动验证（拖动滑块）
   ==========================================================================

   一句话：把滑块从轨道左端推到最右端即完成。没有拼图、没有图片素材 ——
   服务端只下发几何量（见 backend/app/captcha.py）。

   为什么改成「拖到底」而不是「拼图对位」：拼图要人对齐几个像素，手机上经常
   反复划不过去，还要为一张验证码生成并传输两张 PNG。控制台里更常见也更省事
   的做法是「拖到底即通过」，判据退化成「有没有推到末端」——它挡的是最朴素的
   批量撞库，不是针对性攻击，这个取舍在后端注释里写清楚了。

   三个实现细节值得说明：

   1. **几何全部按比例算，不写死像素。**
      登录卡最大 400px 宽（左右各 34px 内边距 → 内容 332px），窄屏还会更窄
      （640px 以下内边距收到 20px，360px 手机上内容只剩 296px）。轨道如果钉死
      320px 就会溢出。所以轨道是宽度 100%，手柄宽度、位移都用百分比；指针位移
      再按「设计坐标 / 实际渲染宽度」换算回设计坐标系 —— 上报给后端的位置必须
      与后端算出的通过阈值同尺度。

   2. **键盘可达靠一个透明的原生 range**，鼠标行为自己实现。
      直接用 `<input type="range">` 最省事，但原生 range 在轨道上按下就会让
      拇指直接跳过去 —— 也就是说「点一下」等同于「拖到位」，这既不符合
      「拖动完成验证」的语义，也等于让人一键跳过验证。所以：轨道上的 input 设
      `pointer-events: none`（只留 Tab + 方向键），指针操作只从手柄起手。

   3. **位置用 ref 往上报，不走 state。**
      拖动过程中每移动 1px 都会触发回调，如果上层用 state 接就会把整个登录
      表单重渲染一遍；登录页只需要在提交时读一次最终值。

   换题（challenge.id 变化）会把位置归零：新题与上一题无关，不归零就会出现
   「滑块停在上一次的落点、看起来已经拖到底」的假象。
   ========================================================================== */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { IconCheck, IconChevronRight } from './Icons';
import type { CaptchaChallenge } from '../api/types';

export interface SliderCaptchaProps {
  challenge: CaptchaChallenge;
  /** 拖动位置变化（设计坐标 px，0 = 未拖动） */
  onPosition: (x: number) => void;
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
  const width = challenge.width ?? 320;
  const handleSize = challenge.handle_size ?? 56;
  const tolerance = challenge.tolerance ?? 6;
  /* 可拖动范围：手柄右缘贴住轨道右缘时的位移 */
  const maxOffset = Math.max(0, width - handleSize);

  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);

  const trackRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /* 拖动起手信息：按下点、当时的偏移、以及渲染像素 → 设计坐标的换算比 */
  const dragRef = useRef<{ startX: number; startOffset: number; scale: number } | null>(
    null,
  );

  /* 已经算「拖到底」：提前把图标换成对勾，让人知道可以点登录了
     （真正的判定在服务端，这里只是同一套阈值的视觉反馈） */
  const reached = offset >= maxOffset - tolerance && offset > 0;

  useEffect(() => {
    setOffset(0);
    dragRef.current = null;
    onPosition(0);
    // onPosition 由上层用 useCallback 固定，不会导致重复归零
  }, [challenge.id, onPosition]);

  const set = useCallback(
    (value: number) => {
      const clamped = Math.min(maxOffset, Math.max(0, Math.round(value)));
      setOffset(clamped);
      onPosition(clamped);
    },
    [maxOffset, onPosition],
  );

  const interactive = !disabled && !loading;

  const onHandleDown = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!interactive) return;
    // 指针捕获：滑出轨道后仍能继续拖，松手也一定能收到事件
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = trackRef.current?.getBoundingClientRect();
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
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    // 松手时已经很接近末端：直接吸附到尽头。
    // 最后几像素手指很难停准，不吸附就会出现「明明推到头了却没通过」。
    if (offset >= maxOffset - tolerance && offset < maxOffset) {
      set(maxOffset);
    }
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
          {offset > 0 ? '' : '请拖动滑块完成验证'}
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
          aria-label="拖动滑块完成验证"
          aria-valuetext={reached ? '已拖到底' : offset > 0 ? `已拖动到 ${offset}` : '尚未拖动'}
          onChange={(event) => set(Number(event.target.value))}
        />
      </div>

      {/* 错误与「已就绪」共用同一个位置：两者互斥，不会同时出现 */}
      {error ? (
        <div className="slider-captcha-error" role="alert">
          {error}
          <button type="button" className="slider-captcha-retry" onClick={onRefresh}>
            换一道
          </button>
        </div>
      ) : reached ? (
        <div className="slider-captcha-ok">已拖到底，点击「登录」完成验证</div>
      ) : null}
    </div>
  );
}
