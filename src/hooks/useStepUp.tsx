/* ==========================================================================
   ProxCenter — 敏感操作二次确认（step-up）
   ==========================================================================

   删虚拟机、改连接凭据、增删账号这类操作，后端会要求「刚刚验证过身份」，
   未确认时返回 403 + X-Step-Up: required。这里把它接成一次弹框：

      业务代码什么都不用写
        → axios 拦截器发现 403
        → 弹出本组件（重输密码 / 动态码）
        → 成功后调用 /auth/step-up
        → 拦截器自动重放原请求

   页面也可以主动调 `useStepUp().requestStepUp()` 提前确认（用于「先确认再
   走多步向导」的场景）。
   ========================================================================== */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { errorMessage, setStepUpHandler } from '../api/client';
import { authApi } from '../api/endpoints';
import { Button } from '../components/ui/Button';
import { Field, Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { IconKey, IconShield } from '../components/Icons';
import { useAuth } from './useAuth';

interface StepUpContextValue {
  /** 主动请求一次二次确认；返回是否通过 */
  requestStepUp: (detail?: string) => Promise<boolean>;
}

const StepUpContext = createContext<StepUpContextValue | null>(null);

export function StepUpProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  /* 弹框与调用方之间的「结果」桥梁：一个待兑现的 promise */
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  /* 并发请求（页面同时删两台机器）共用同一个弹框，别弹两次 */
  const pending = useRef<Promise<boolean> | null>(null);

  const requestStepUp = useCallback((message = '') => {
    if (pending.current) return pending.current;

    const promise = new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setDetail(message);
      setPassword('');
      setCode('');
      setError(undefined);
      setOpen(true);
    });
    pending.current = promise;
    return promise;
  }, []);

  /* 把弹框注册给 axios 拦截器（避免 client.ts 直接依赖 React） */
  useEffect(() => {
    setStepUpHandler((message) => requestStepUp(message));
    return () => setStepUpHandler(null);
  }, [requestStepUp]);

  const settle = useCallback((ok: boolean) => {
    setOpen(false);
    const resolve = resolver.current;
    resolver.current = null;
    pending.current = null;
    resolve?.(ok);
  }, []);

  const submit = async () => {
    if (busy) return;
    if (!password) {
      setError('请输入登录密码');
      return;
    }
    const needCode = Boolean(user?.totp_enabled);
    if (needCode && !code.trim()) {
      setError('请输入两步验证动态码或一张恢复码');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await authApi.stepUp(password, needCode ? code.trim() : undefined);
      settle(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepUpContext.Provider value={{ requestStepUp }}>
      {children}
      <Modal
        open={open}
        onClose={() => settle(false)}
        title="请确认身份"
        description={
          detail || '该操作影响较大，需要重新验证一次身份后才能继续。'
        }
        size="sm"
        hideClose
      >
        {error ? (
          <div className="login-error" role="alert">
            {error}
          </div>
        ) : null}
        <Field label="登录密码" required>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="确认是你本人操作"
            autoComplete="current-password"
            autoFocus
            prefix={<IconKey size={15} />}
          />
        </Field>
        {user?.totp_enabled ? (
          <Field
            label="两步验证动态码"
            required
            hint="也可以用一张一次性恢复码"
          >
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456 或 ABCD-EFGH"
              autoComplete="one-time-code"
              maxLength={16}
              prefix={<IconShield size={15} />}
            />
          </Field>
        ) : null}
        <div className="form-row" style={{ justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={() => settle(false)} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy}>
            确认并继续
          </Button>
        </div>
      </Modal>
    </StepUpContext.Provider>
  );
}

export function useStepUp(): StepUpContextValue {
  const ctx = useContext(StepUpContext);
  if (!ctx) {
    throw new Error('useStepUp 必须在 <StepUpProvider> 内部使用');
  }
  return ctx;
}
