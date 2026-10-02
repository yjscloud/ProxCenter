/* ==========================================================================
   ProxCenter — 忘记密码（自助重置第 1 步）
   填用户名 → 面板给该账号邮箱发一条 30 分钟有效的一次性链接。

   刻意不告诉访问者「这个用户名存不存在」：这是公开页面，
   一旦能区分，就等于给了别人一台账号枚举机。
   ========================================================================== */

import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { authApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Notice } from '../components/ui/EmptyState';
import { IconAlert, IconUser } from '../components/Icons';
import { AuthShell } from '../components/AuthShell';
import { useT } from '../i18n';

export function ForgotPassword() {
  const t = useT();
  const [username, setUsername] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (!username.trim()) {
      setError(t('forgot.err.usernameRequired'));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await authApi.forgotPassword({ username: username.trim() });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell>
          {sent ? (
            <>
              <h1 className="login-title">{t('forgot.sentTitle')}</h1>
              <p className="login-subtitle">{t('forgot.sentSubtitle')}</p>

              <div className="mb-16">
                <Notice tone="success" title={t('forgot.noticeTitle')}>
                  {t('forgot.noticeBodyPre')}
                  <b>{t('forgot.noticeBodyStrong')}</b>
                  {t('forgot.noticeBodyPost')}
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
            <>
              <h1 className="login-title">{t('forgot.title')}</h1>
              <p className="login-subtitle">{t('forgot.subtitle')}</p>

              <form className="login-form" onSubmit={handleSubmit} noValidate>
                {error ? (
                  <div className="login-error" role="alert">
                    <IconAlert size={16} />
                    <span>{error}</span>
                  </div>
                ) : null}

                <Input
                  label={t('auth.login.username')}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={t('register.usernamePlaceholder')}
                  autoComplete="username"
                  autoFocus
                  disabled={submitting}
                  prefix={<IconUser size={15} />}
                  hint={t('forgot.usernameHint')}
                  required
                />

                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  block
                  loading={submitting}
                  disabled={!username.trim()}
                >
                  {submitting ? t('forgot.submitting') : t('forgot.submit')}
                </Button>
              </form>

              <div className="login-health">
                <div className="login-health-row">
                  <span className="login-health-label">{t('forgot.remembered')}</span>
                  <Link to="/login" className="fs-sm">
                    {t('auth.backToLogin')}
                  </Link>
                </div>
              </div>
            </>
          )}
    </AuthShell>
  );
}
