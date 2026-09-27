/* ==========================================================================
   ProxCenter — 设置新密码（自助重置第 2 步）
   从邮件链接进来（/reset-password?token=...），校验令牌后设置新密码。

   令牌校验在打开页面时就做：链接失效了就直接说明原因，
   别让人填完密码才发现提交不上去。
   ========================================================================== */

import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { authApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Notice } from '../components/ui/EmptyState';
import { IconAlert, IconCheck, IconEye, IconEyeOff, IconKey } from '../components/Icons';
import { AuthShell } from '../components/AuthShell';

/* 三个状态：还没查到结果 / 链接可用 / 链接不可用 */
type TokenState = 'checking' | 'valid' | 'invalid';

export function ResetPassword() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = (searchParams.get('token') || '').trim();

  const [state, setState] = useState<TokenState>('checking');
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) {
      setState('invalid');
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await authApi.checkResetToken(token);
        if (cancelled) return;
        setState(res.valid ? 'valid' : 'invalid');
        setAccount(res.username);
      } catch {
        if (!cancelled) setState('invalid');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const validate = (): boolean => {
    const next: Record<string, string> = {};
    if (!password) {
      next.password = '请输入新密码';
    } else if (password.length < 8) {
      next.password = '密码至少 8 位';
    } else if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
      next.password = '密码需同时包含字母与数字';
    }
    if (!confirm) {
      next.confirm = '请再次输入新密码';
    } else if (confirm !== password) {
      next.confirm = '两次输入的密码不一致';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    if (!validate()) return;

    setSubmitting(true);
    try {
      await authApi.resetPassword(token, password);
      // 成功后回登录页：令牌已作废，留在本页没有意义
      navigate('/login', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell>
          {state === 'checking' ? (
            <>
              <h1 className="login-title">正在校验链接…</h1>
              <p className="login-subtitle">请稍候</p>
            </>
          ) : null}

          {state === 'invalid' ? (
            <>
              <h1 className="login-title">链接已失效</h1>
              <p className="login-subtitle">可能已过期或已被使用</p>

              <div className="mb-16">
                <Notice tone="warning" title="无法使用这条链接">
                  重置链接 30 分钟内有效，且只能用一次。请重新申请一条，
                  或联系管理员手动重置密码。
                </Notice>
              </div>

              <div className="login-form">
                <Link to="/forgot-password" style={{ textDecoration: 'none' }}>
                  <Button variant="primary" size="lg" block>
                    重新申请重置链接
                  </Button>
                </Link>
              </div>

              <div className="login-health">
                <div className="login-health-row">
                  <span className="login-health-label">想起密码了？</span>
                  <Link to="/login" className="fs-sm">
                    返回登录
                  </Link>
                </div>
              </div>
            </>
          ) : null}

          {state === 'valid' ? (
            <>
              <h1 className="login-title">设置新密码</h1>
              <p className="login-subtitle">
                账号 <b className="mono">{account}</b>
              </p>

              <form className="login-form" onSubmit={handleSubmit} noValidate>
                {error ? (
                  <div className="login-error" role="alert">
                    <IconAlert size={16} />
                    <span>{error}</span>
                  </div>
                ) : null}

                <Input
                  label="新密码"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="至少 8 位，含字母与数字"
                  autoComplete="new-password"
                  autoFocus
                  disabled={submitting}
                  prefix={<IconKey size={15} />}
                  error={errors.password}
                  required
                  suffix={
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? '隐藏密码' : '显示密码'}
                      title={showPassword ? '隐藏密码' : '显示密码'}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--text-muted)',
                        cursor: 'pointer',
                        display: 'inline-flex',
                        padding: 0,
                      }}
                    >
                      {showPassword ? <IconEyeOff size={15} /> : <IconEye size={15} />}
                    </button>
                  }
                />

                <Input
                  label="确认新密码"
                  type={showPassword ? 'text' : 'password'}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="再次输入新密码"
                  autoComplete="new-password"
                  disabled={submitting}
                  prefix={<IconCheck size={15} />}
                  error={errors.confirm}
                  required
                />

                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  block
                  loading={submitting}
                >
                  {submitting ? '正在设置…' : '设置新密码'}
                </Button>
              </form>
            </>
          ) : null}
    </AuthShell>
  );
}
