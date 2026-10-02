/* ==========================================================================
   ProxCenter — 应用入口
   ========================================================================== */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { ToastProvider } from './hooks/useToast';
import { AuthProvider } from './hooks/useAuth';
import { StepUpProvider } from './hooks/useStepUp';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LanguageCacheReset } from './components/LanguageCacheReset';
import { I18nProvider } from './i18n';

import './styles/theme.css';
import './styles/global.css';
import './styles/components.css';
import './styles/layout.css';
import './styles/charts.css';
import './styles/settings.css';
/* 产品官网（公开首页 /）的样式。按页面自上而下拆成四块，便于单块改动与
   增量解析 —— 首页整页样式集中在一个文件里时，任何一次微调都要全量重解析。
   四块的顺序即层叠顺序：令牌 → 骨架/顶栏 → 首屏与中段 → 后段与响应式。 */
import './styles/landing.css';
import './styles/landing-sections.css';
import './styles/landing-detail.css';
import './styles/landing-tail.css';
/* 移动端适配放最后：它要在既有规则之上做窄屏覆盖 */
import './styles/responsive.css';

/* ---------------------------------------------------------------------------
   React Query 配置
   --------------------------------------------------------------------------- */

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 运维面板数据变化快，默认缓存 30 秒
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        // 401 / 501 不重试
        if (error && typeof error === 'object' && 'status' in error) {
          const status = (error as { status: number }).status;
          if (status === 401 || status === 403 || status === 501) return false;
        }
        return failureCount < 2;
      },
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
    },
    mutations: {
      retry: false,
    },
  },
});

/* ---------------------------------------------------------------------------
   挂载
   --------------------------------------------------------------------------- */

const container = document.getElementById('root');
if (!container) {
  throw new Error('未找到 #root 挂载点');
}

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      {/* 语言放在最外层：登录页、路由错误页这些「还没有用户」的界面也要能切换语言 */}
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          {/* 后端按 Accept-Language 本地化的接口（作业名、权限目录、角色名…）
              其 queryKey 不含语言，切语言后必须重取，否则一直显示旧语言 */}
          <LanguageCacheReset />
          <BrowserRouter>
            <ToastProvider>
              <AuthProvider>
                {/* 必须在 AuthProvider 内层：二次确认要按当前用户判断有没有开 2FA */}
                <StepUpProvider>
                  <App />
                </StepUpProvider>
              </AuthProvider>
            </ToastProvider>
          </BrowserRouter>
        </QueryClientProvider>
      </I18nProvider>
    </ErrorBoundary>
  </StrictMode>,
);
