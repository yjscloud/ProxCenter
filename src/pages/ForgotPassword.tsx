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

export function ForgotPassword() {
  const [username, setUsername] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (!username.trim()) {
      setError('请输入用户名');
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
              <h1 className="login-title">邮件已发送</h1>
              <p className="login-subtitle">请查收邮箱并点击链接</p>

              <div className="mb-16">
                <Notice tone="success" title="请查收邮件">
                  如果该账号存在且已填写邮箱，重置链接已发送到其注册邮箱，
                  <b>30 分钟内有效，且只能使用一次</b>。
                  没收到的话请检查垃圾邮件，或联系管理员手动重置。
                </Notice>
              </div>

              <div className="login-form">
                <Link to="/login" style={{ textDecoration: 'none' }}>
                  <Button variant="primary" size="lg" block>
                    返回登录
                  </Button>
                </Link>
              </div>
            </>
          ) : (
            <>
              <h1 className="login-title">重置密码</h1>
              <p className="login-subtitle">
                输入用户名，重置链接会发到该账号的邮箱
              </p>

              <form className="login-form" onSubmit={handleSubmit} noValidate>
                {error ? (
                  <div className="login-error" role="alert">
                    <IconAlert size={16} />
                    <span>{error}</span>
                  </div>
                ) : null}

                <Input
                  label="用户名"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="例如 zhangsan"
                  autoComplete="username"
                  autoFocus
                  disabled={submitting}
                  prefix={<IconUser size={15} />}
                  hint="重置链接会发到这个账号注册时填写的邮箱"
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
                  {submitting ? '正在提交…' : '发送重置链接'}
                </Button>
              </form>

              <div className="login-health">
                <div className="login-health-row">
                  <span className="login-health-label">想起密码了？</span>
                  <Link to="/login" className="fs-sm">
                    返回登录
                  </Link>
                </div>
              </div>
            </>
          )}
    </AuthShell>
  );
}
