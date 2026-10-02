/* ==========================================================================
   产品官网 — 能力矩阵
   ==========================================================================
   这一块是整页信息密度的重心：把全部能力条目按能力域铺开，并支持
     ① 关键词检索（名称 / 描述 / 域名的模糊匹配）
     ② 能力域筛选
   两个条件是「与」的关系，所以点了「安全」再搜「模板」会得到空结果 ——
   空状态里给出「清除筛选」，而不是让用户自己猜为什么没有。

   版式上用「左侧能力域栏 + 右侧条目网格」而不是顶部一排筛选胶囊：能力域有
   七个，横向排开必然折行，折行之后名称与计数对不上，反而看不出「这一域有
   多少条」。侧栏还顺带承担了「整页有哪些能力域」这层信息。
   ========================================================================== */

import { useMemo } from 'react';
import { IconClose, IconLayout, IconSearch } from '../../components/Icons';
import { useT } from '../../i18n';
import type { ResolvedDomain } from './content';
import { useLandingContent } from './hooks';
import { SectionHead } from './Common';

export interface MatrixProps {
  query: string;
  onQueryChange: (value: string) => void;
  /** 'all' 或某个能力域 id */
  activeDomain: string;
  onDomainChange: (domainId: string) => void;
}

export function Matrix({ query, onQueryChange, activeDomain, onDomainChange }: MatrixProps) {
  const t = useT();
  const { domains, capabilities, capabilityTotal } = useLandingContent();
  const keyword = query.trim().toLowerCase();

  const results = useMemo(
    () =>
      capabilities.filter((item) => {
        if (activeDomain !== 'all' && item.domainId !== activeDomain) return false;
        if (!keyword) return true;
        return (
          item.name.toLowerCase().includes(keyword) ||
          item.desc.toLowerCase().includes(keyword) ||
          item.domainName.toLowerCase().includes(keyword)
        );
      }),
    [capabilities, keyword, activeDomain],
  );

  const filtering = keyword !== '' || activeDomain !== 'all';

  const reset = () => {
    onQueryChange('');
    onDomainChange('all');
  };

  return (
    <section className="lp-section" id="matrix">
      <div className="lp-container">
        <SectionHead
          index="01"
          eyebrow="Capabilities"
          title={t('landing.matrix.title', { total: capabilityTotal })}
          desc={t('landing.matrix.desc')}
        />

        <div className="lp-matrix-layout">
          <nav className="lp-domain-rail" aria-label={t('landing.matrix.domainsAria')}>
            <div className="lp-domain-rail-label">{t('landing.matrix.domains')}</div>

            <button
              type="button"
              className={`lp-domain-btn${activeDomain === 'all' ? ' is-active' : ''}`}
              aria-pressed={activeDomain === 'all'}
              onClick={() => onDomainChange('all')}
            >
              <span className="lp-domain-btn-icon">
                <IconLayout size={16} />
              </span>
              <span className="lp-domain-btn-body">
                <span className="lp-domain-btn-name">{t('landing.allCapabilities')}</span>
              </span>
              <span className="lp-domain-btn-count">{capabilityTotal}</span>
            </button>

            {domains.map((domain) => (
              <button
                key={domain.id}
                type="button"
                className={`lp-domain-btn${activeDomain === domain.id ? ' is-active' : ''}`}
                aria-pressed={activeDomain === domain.id}
                onClick={() => onDomainChange(domain.id)}
              >
                <span className="lp-domain-btn-icon">{domain.icon}</span>
                <span className="lp-domain-btn-body">
                  <span className="lp-domain-btn-name">{domain.name}</span>
                  <span className="lp-domain-btn-en">{domain.en}</span>
                </span>
                <span className="lp-domain-btn-count">{domain.items.length}</span>
              </button>
            ))}
          </nav>

          <div className="lp-matrix-main">
            <div className="lp-matrix-toolbar">
              <div className="lp-matrix-search">
                <span className="lp-matrix-search-icon" aria-hidden="true">
                  <IconSearch size={16} />
                </span>
                <input
                  type="search"
                  value={query}
                  aria-label={t('landing.matrix.searchAria')}
                  placeholder={t('landing.matrix.searchPlaceholder')}
                  onChange={(event) => onQueryChange(event.target.value)}
                />
                {query ? (
                  <button
                    type="button"
                    className="lp-matrix-search-clear"
                    aria-label={t('landing.matrix.clearKeyword')}
                    onClick={() => onQueryChange('')}
                  >
                    <IconClose size={14} />
                  </button>
                ) : null}
              </div>

              <div className="lp-matrix-meta" aria-live="polite">
                {filtering ? (
                  <>
                    {t('landing.matrix.matchedPre')}
                    <strong>{results.length}</strong>
                    {t('landing.matrix.matchedPost')}
                    {keyword
                      ? t('landing.matrix.matchedKeyword', { keyword: query.trim() })
                      : ''}
                    <button type="button" className="lp-matrix-reset" onClick={reset}>
                      {t('landing.matrix.reset')}
                    </button>
                  </>
                ) : (
                  <>
                    {t('landing.matrix.total', {
                      total: capabilityTotal,
                      domains: domains.length,
                    })}
                  </>
                )}
              </div>
            </div>

            {results.length > 0 ? (
              <div className="lp-matrix">
                {results.map((item) => (
                  <article
                    className="lp-cap lp-ticks lp-reveal"
                    key={`${item.domainId}-${item.name}`}
                  >
                    <span className="lp-icon-box">{item.icon}</span>
                    <div className="lp-cap-body">
                      <div className="lp-cap-head">
                        <span className="lp-cap-name">{item.name}</span>
                        <span className="lp-cap-domain">{item.domainName}</span>
                      </div>
                      <p className="lp-cap-desc">{item.desc}</p>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="lp-matrix-empty">
                <p className="lp-h3">{t('landing.matrix.emptyTitle')}</p>
                <p className="lp-p">
                  {t('landing.matrix.emptyDesc', {
                    domain:
                      activeDomain === 'all'
                        ? t('landing.matrix.allDomains')
                        : domainLabel(activeDomain, domains),
                    keyword: keyword
                      ? t('landing.matrix.emptyKeyword', { keyword: query.trim() })
                      : '',
                  })}
                </p>
                <button type="button" className="lp-btn lp-btn-ghost" onClick={reset}>
                  {t('landing.matrix.reset')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function domainLabel(domainId: string, domains: ResolvedDomain[]): string {
  return domains.find((d) => d.id === domainId)?.name ?? domainId;
}
