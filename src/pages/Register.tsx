/* ==========================================================================
   ProxCenter — 注册页
   自助注册出来的账号状态是「待审批」，管理员放行后才能登录。
   ========================================================================== */

import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { authApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Notice } from '../components/ui/EmptyState';
import {
  IconAlert,
  IconCheck,
  IconEye,
  IconEyeOff,
  IconKey,
  IconUser,
} from '../components/Icons';
import { AuthShell } from '../components/AuthShell';
import { useT } from '../i18n';

/* 与后端 users.py 的用户名规则保持一致 */
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

export function Register() {
  const t = useT();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const validate = (): boolean => {
    const next: Record<string, string> = {};
    const name = username.trim();

    if (!name) {
      next.username = t('register.err.usernameRequired');
    } else if (!USERNAME_RE.test(name)) {
      next.username = t('register.err.usernameRule');
    }

    // 邮箱必填：审批结果（通过 / 拒绝）会发到这里
    if (!email.trim()) {
      next.email = t('register.err.emailRequired');
    } else if (!email.includes('@')) {
      next.email = t('register.err.emailInvalid');
    }

    if (!password) {
      next.password = t('register.err.passwordRequired');
    } else if (password.length < 8) {
      next.password = t('register.err.passwordTooShort');
    } else if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
      next.password = t('register.err.passwordWeak');
    }

    if (!confirm) {
      next.confirm = t('register.err.confirmRequired');
    } else if (confirm !== password) {
      next.confirm = t('register.err.confirmMismatch');
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
      await authApi.register({
        username: username.trim(),
        password,
        email: email.trim(),
      });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell>
      <h1 className="login-title">
        {done ? t('register.titleDone') : t('register.title')}
      </h1>
      <p className="login-subtitle">
        {done ? t('register.subtitleDone') : t('register.subtitle')}
      </p>

      {done ? (
        <>
          <div className="mb-16">
            <Notice tone="success" title={t('register.successTitle')}>
              {t('register.successBodyPre')}
              <b className="mono">{username.trim()}</b>
              {t('register.successBodyPost')}
            </Notice>
          </div>

          <div className="login-form">
            <Link to="/login" style={{ textDecoration: 'none' }}>
              <Button variant="primary" size="lg" block>
                {t('auth.backToLogin')}
              </Button>
            </Link>
          </div>
        </>
      ) : (
        <form className="login-form" onSubmit={handleSubmit} noValidate>
          {error ? (
            <div className="login-error" role="alert">
              <IconAlert size={16} />
              <span>{error}</span>
            </div>
          ) : null}

          <Input
            label={t('register.username')}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={t('register.usernamePlaceholder')}
            autoComplete="username"
            autoFocus
            disabled={submitting}
            prefix={<IconUser size={15} />}
            error={errors.username}
            hint={t('register.usernameHint')}
            required
          />

          <Input
            label={t('register.email')}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t('register.emailPlaceholder')}
            autoComplete="email"
            disabled={submitting}
            error={errors.email}
            hint={t('register.emailHint')}
            required
          />

          <Input
            label={t('register.password')}
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t('register.passwordPlaceholder')}
            autoComplete="new-password"
            disabled={submitting}
            prefix={<IconKey size={15} />}
            error={errors.password}
            required
            suffix={
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={
                  showPassword ? t('auth.login.hidePassword') : t('auth.login.showPassword')
                }
                title={
                  showPassword ? t('auth.login.hidePassword') : t('auth.login.showPassword')
                }
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
            label={t('register.confirmPassword')}
            type={showPassword ? 'text' : 'password'}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder={t('register.confirmPlaceholder')}
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
            {submitting ? t('register.submitting') : t('register.submit')}
          </Button>
        </form>
      )}

      <div className="login-health">
        <div className="login-health-row">
          <span className="login-health-label">{t('register.haveAccount')}</span>
          <Link to="/login" className="fs-sm">
            {t('auth.backToLogin')}
          </Link>
        </div>
      </div>
    </AuthShell>
  );
}
