/* ==========================================================================
   ProxCenter — 语言切换

   四种形态，样式各随其位：
   - variant="topbar"：面板顶栏常驻（登录后的默认入口）—— 切换语言是
     「找得到才用得上」的功能，收进头像菜单里等于没有；
   - variant="menu"：头像菜单里的整行（保留给菜单场景）；
   - variant="pill"：认证页顶栏的胶囊按钮（未登录时用）；
   - variant="landing"：产品官网顶栏。自绘「按钮 + 浮层」而不是原生 select ——
     官网顶栏是自绘视觉，系统控件会露出一截系统配色（边框、箭头、列表底
     色），怎么调都不像同一个界面。

   语言名一律用它自己的语言书写（中文 / English），不随界面语言翻译。
   ========================================================================== */

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { LANGS, useI18n, type Lang } from '../i18n';
import { IconGlobe } from './Icons';
import { prefsApi } from '../api/endpoints';

export interface LanguageSelectProps {
  variant?: 'menu' | 'pill' | 'topbar' | 'landing';
}

/** 列表里的全名 */
function languageLabel(code: Lang): string {
  return code === 'zh-CN' ? '中文' : 'English';
}

/** 顶栏按钮上的短标签：顶栏空间紧张，只写「中文 / EN」 */
function shortLabel(code: Lang): string {
  return code === 'zh-CN' ? '中文' : 'EN';
}

const VARIANT_CLASS = {
  menu: 'is-menu',
  pill: 'is-pill',
  topbar: 'is-topbar',
} as const;

export function LanguageSelect({ variant = 'menu' }: LanguageSelectProps) {
  const { lang, setLang, t } = useI18n();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  /**
   * 切换语言，三件事一起做：
   *   1. 本地立即生效（界面马上变）；
   *   2. 同步到服务端 —— 它决定「发给这个人的通知邮件用哪种语言」，
   *      未登录（登录页/官网）或写入失败都不影响本地切换，静默处理；
   *   3. 让带后端文案的缓存重新拉一遍（权限目录 / FAQ / 角色名 / 错误消息）。
   */
  const choose = (next: Lang) => {
    setOpen(false);
    if (next === lang) return;
    setLang(next);
    void prefsApi.save('language', next).catch(() => undefined);
    void queryClient.invalidateQueries();
  };

  /* 浮层形态：点外部 / 按 Escape 关闭（与官网能力面板同一套交互约定） */
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (variant === 'landing') {
    return (
      <div className="lp-lang" ref={rootRef}>
        <button
          type="button"
          className="lp-lang-btn"
          onClick={() => setOpen((value) => !value)}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={t('lang.switchTo')}
          title={t('lang.switchTo')}
        >
          <IconGlobe size={14} />
          <span>{shortLabel(lang)}</span>
        </button>

        {open ? (
          <div className="lp-lang-menu" role="listbox" aria-label={t('lang.switchTo')}>
            {LANGS.map((code) => (
              <button
                key={code}
                type="button"
                role="option"
                aria-selected={code === lang}
                className={`lp-lang-item${code === lang ? ' is-active' : ''}`}
                onClick={() => choose(code)}
              >
                {languageLabel(code)}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <label
      className={`lang-select ${VARIANT_CLASS[variant]}`}
      title={t('lang.switchTo')}
    >
      <IconGlobe size={15} />
      <select
        value={lang}
        aria-label={t('lang.switchTo')}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => {
          choose(event.target.value as Lang);
        }}
      >
        {LANGS.map((code) => (
          <option key={code} value={code}>
            {languageLabel(code)}
          </option>
        ))}
      </select>
    </label>
  );
}
