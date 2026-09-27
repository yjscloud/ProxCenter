/* ==========================================================================
   ProxCenter — 第三方库类型补充
   ========================================================================== */

/**
 * @novnc/novnc 以 ESM 源码分发，不带 TypeScript 类型声明。
 * 这里声明我们用到的 API 子集（RFB 构造函数与常用事件）。
 */
declare module '@novnc/novnc' {
  export interface RFBCredentials {
    username?: string;
    password?: string;
    target?: string;
  }

  export interface RFBOptions {
    credentials?: RFBCredentials;
    shared?: boolean;
    repeaterID?: string;
    wsProtocols?: string[];
  }

  export interface RFBEventMap {
    connect: CustomEvent<null>;
    disconnect: CustomEvent<{ clean: boolean }>;
    credentialsrequired: CustomEvent<null>;
    securityfailure: CustomEvent<{ status: number; reason: string }>;
    desktopname: CustomEvent<{ name: string }>;
    clipboard: CustomEvent<{ text: string }>;
    bell: CustomEvent<null>;
  }

  export default class RFB extends EventTarget {
    constructor(
      target: Element,
      url: string,
      options?: RFBOptions,
    );

    /** 缩放视口以适配容器 */
    scaleViewport: boolean;
    /** 容器尺寸变化时自动裁剪/拉伸 */
    resizeSession: boolean;
    /** 只读模式（不发送键鼠事件）*/
    viewOnly: boolean;
    /** 剪贴板内容 */
    clipboardPasteFrom(text: string): void;
    /** 发送 Ctrl+Alt+Del */
    sendCtrlAltDel(): void;
    focus(): void;
    blur(): void;
    disconnect(): void;
    approveServer(): void;

    addEventListener<K extends keyof RFBEventMap>(
      type: K,
      listener: (event: RFBEventMap[K]) => void,
    ): void;
    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
    ): void;
  }
}
