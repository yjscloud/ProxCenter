/* ==========================================================================
   ProxCenter — 注册页
   自助注册出来的账号状态是「待审批」，管理员放行后才能登录。
   ========================================================================== */

import { useCallback, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { authApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Notice } from '../components/ui/EmptyState';
import { SliderCaptcha } from '../components/SliderCaptcha';
import type { SliderTracePoint } from '../api/types';
import {
  IconAlert,
  IconCheck,
  IconEye,
  IconEyeOff,
  IconKey,
  IconShield,
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
  const [captchaCode, setCaptchaCode] = useState('');
  /* 字段级错误：置空用 undefined（清掉某一个字段的提示，而不是整表重建） */
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  /*
    人机校验：与登录共用同一套「设置 → 登录验证」配置（关闭 / 图形码 / 滑块）。
    单独一个 queryKey —— 挑战是一次性的，和登录页共用缓存会互相把对方的题作废。
  */
  const captchaQ = useQuery({
    queryKey: ['register-captcha'],
    queryFn: authApi.captcha,
    refetchOnWindowFocus: false,
    staleTime: 0,
    retry: 1,
  });
  const captchaMode =
    captchaQ.data?.mode ?? (captchaQ.data?.required ? 'image' : 'off');
  const captchaRequired = captchaMode !== 'off';

  /* 滑块位置只在提交时读一次，拖动过程中不触发整表单重渲染（同登录页） */
  const sliderXRef = useRef(0);
  /* 拖动轨迹：只交坐标不交轨迹会被服务端判失败（安全审计 H-1） */
  const sliderPathRef = useRef<SliderTracePoint[]>([]);
  const handleSliderPosition = useCallback((x: number, path: SliderTracePoint[]) => {
    sliderXRef.current = x;
    sliderPathRef.current = path;
    if (x > 0) {
      setErrors((prev) => (prev.captcha ? { ...prev, captcha: undefined } : prev));
    }
  }, []);

  const validate = (): boolean => {
    const next: Record<string, string | undefined> = {};
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

    if (captchaMode === 'image' && !captchaCode.trim()) {
      next.captcha = t('auth.err.captchaRequired');
    } else if (captchaMode === 'slider') {
      /* 目标位置只在轨道图里，本地只能拦「压根没拖」，对齐与否交给服务端 */
      if (sliderXRef.current <= 0) {
        next.captcha = t('auth.err.sliderRequired');
      }
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
        captcha_id: captchaRequired ? (captchaQ.data?.id ?? '') : undefined,
        captcha_code:
          captchaMode === 'image' ? captchaCode.trim() : undefined,
        captcha_x: captchaMode === 'slider' ? sliderXRef.current : undefined,
        captcha_path: captchaMode === 'slider' ? sliderPathRef.current : undefined,
      });
      setDone(true);
    } catch (err) {
      const msg = errorMessage(err);
      /* 验证码类失败归位到验证码字段，其余走顶部横幅（同登录页） */
      if (captchaRequired && /验证码|滑块/.test(msg)) {
        setErrors({ captcha: msg });
      } else {
        setError(msg);
      }
      /* 挑战一次性：失败后换一张，顺带清掉上次作答 */
      if (captchaRequired) {
        setCaptchaCode('');
        sliderXRef.current = 0;
        void captchaQ.refetch();
      }
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

          {/* 人机校验：文案复用登录页那几条（同为「验证码 / 拖动滑块」） */}
          {captchaMode === 'image' ? (
            <div className="login-captcha">
              <div className="login-captcha-input">
                <Input
                  label={t('auth.login.captcha')}
                  value={captchaCode}
                  onChange={(e) => setCaptchaCode(e.target.value)}
                  placeholder={t('auth.login.captchaPlaceholder')}
                  autoComplete="off"
                  autoCapitalize="characters"
                  disabled={submitting}
                  maxLength={8}
                  prefix={<IconShield size={15} />}
                  error={errors.captcha}
                  required
                />
              </div>
              <button
                type="button"
                className="login-captcha-img"
                onClick={() => {
                  setCaptchaCode('');
                  setErrors((prev) => ({ ...prev, captcha: undefined }));
                  void captchaQ.refetch();
                }}
                title={t('auth.login.captchaRefresh')}
                aria-label={t('auth.login.captchaRefreshAria')}
              >
                {captchaQ.data?.image ? (
                  <img src={captchaQ.data.image} alt={t('auth.login.captchaAlt')} />
                ) : (
                  <span>
                    {captchaQ.isFetching
                      ? t('auth.login.captchaLoading')
                      : t('auth.login.captchaFailed')}
                  </span>
                )}
              </button>
            </div>
          ) : captchaMode === 'slider' ? (
            <SliderCaptcha
              challenge={captchaQ.data ?? { required: true, mode: 'slider' }}
              onPosition={handleSliderPosition}
              onRefresh={() => {
                sliderXRef.current = 0;
                setErrors((prev) => ({ ...prev, captcha: undefined }));
                void captchaQ.refetch();
              }}
              loading={captchaQ.isFetching}
              disabled={submitting}
              error={errors.captcha}
            />
          ) : null}

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
