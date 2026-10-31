/* ==========================================================================
   ProxCenter — 每帧最多执行一次的小工具

   `resize` / `scroll` / `ResizeObserver` 这类事件在一帧里可能触发多次（拖窗口
   边缘、触控板惯性滚动）。处理函数里如果直接做布局计算或 `setState`，就会在
   同一帧里排队做几遍 —— 用户看到的是掉帧。

   已经按这个写法的地方：`ConsoleXterm` 的容器尺寸跟随。这里把它抽出来，
   新代码不用每次手写一遍 `cancelAnimationFrame` + `requestAnimationFrame`。
   ========================================================================== */

/**
 * 返回一个「同一帧内只跑最后一次」的包装函数，以及一个 `cancel`。
 *
 * 取消是必须的：组件卸载后仍有一帧待执行的话，`fit()` 之类的调用会打到已经
 * 销毁的实例上（xterm 会抛 `Cannot read properties of undefined`）。
 */
export function rafThrottle<A extends unknown[]>(
  fn: (...args: A) => void,
): { run: (...args: A) => void; cancel: () => void } {
  let frame = 0;
  let lastArgs: A | null = null;

  const run = (...args: A) => {
    lastArgs = args;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const args2 = lastArgs;
      lastArgs = null;
      if (args2) fn(...args2);
    });
  };

  const cancel = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    lastArgs = null;
  };

  return { run, cancel };
}
