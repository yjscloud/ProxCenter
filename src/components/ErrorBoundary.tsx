/* ==========================================================================
   ProxCenter — ErrorBoundary
   ========================================================================== */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** 自定义回退 UI */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 便于开发定位；生产可接入日志服务
    console.error('[ProxCenter] 渲染错误:', error, info.componentStack);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) {
      return this.props.fallback(error, this.reset);
    }

    return (
      <div className="error-boundary" role="alert">
        <div className="error-boundary-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="34" height="34">
            <path
              d="M12 3.5 21 19H3z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinejoin="round"
            />
            <path
              d="M12 9.5v4M12 16.5h.01"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.1"
              strokeLinecap="round"
            />
          </svg>
        </div>
        <h2 className="error-boundary-title">页面出现异常</h2>
        <p className="error-boundary-message">
          {error.message || '发生了未知的渲染错误'}
        </p>
        <div className="error-boundary-actions">
          <button type="button" className="btn btn-primary" onClick={this.reset}>
            重试渲染
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => window.location.reload()}
          >
            刷新页面
          </button>
        </div>
        {import.meta.env.DEV ? (
          <pre className="error-boundary-stack">{error.stack}</pre>
        ) : null}
      </div>
    );
  }
}
