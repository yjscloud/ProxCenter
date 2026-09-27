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

/* 与后端 users.py 的用户名规则保持一致 */
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

export function Register() {
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
      next.username = '请输入用户名';
    } else if (!USERNAME_RE.test(name)) {
      next.username = '3-32 位，仅限字母、数字、点、下划线与短横线';
    }

    // 邮箱必填：审批结果（通过 / 拒绝）会发到这里
    if (!email.trim()) {
      next.email = '请输入邮箱，审批结果会发送到该邮箱';
    } else if (!email.includes('@')) {
      next.email = '邮箱格式不正确';
    }

    if (!password) {
      next.password = '请输入密码';
    } else if (password.length < 8) {
      next.password = '密码至少 8 位';
    } else if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
      next.password = '密码需同时包含字母与数字';
    }

    if (!confirm) {
      next.confirm = '请再次输入密码';
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
        {done ? '申请已提交' : '注册账号'}
      </h1>
      <p className="login-subtitle">
        {done
          ? '接下来等待管理员审批'
          : '提交后需管理员审批，通过后才能登录'}
      </p>

      {done ? (
        <>
          <div className="mb-16">
            <Notice tone="success" title="注册成功，等待审批">
              账号 <b className="mono">{username.trim()}</b> 已创建，
              但需要管理员审批通过后才能登录。审批结果与所需时间请联系管理员确认。
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
            error={errors.username}
            hint="3-32 位，仅限字母、数字、点、下划线与短横线"
            required
          />

          <Input
            label="邮箱"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="用于接收审批结果"
            autoComplete="email"
            disabled={submitting}
            error={errors.email}
            hint="审批通过或拒绝都会发到这个邮箱，请填写真实地址"
            required
          />

          <Input
            label="密码"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="至少 8 位，含字母与数字"
            autoComplete="new-password"
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
            label="确认密码"
            type={showPassword ? 'text' : 'password'}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="再次输入密码"
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
            {submitting ? '正在提交…' : '提交注册申请'}
          </Button>
        </form>
      )}

      <div className="login-health">
        <div className="login-health-row">
          <span className="login-health-label">已经有账号了？</span>
          <Link to="/login" className="fs-sm">
            返回登录
          </Link>
        </div>
      </div>
    </AuthShell>
  );
}
