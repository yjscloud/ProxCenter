/* ==========================================================================
   ProxCenter — 设置
   区块：Proxmox 连接配置 / 面板设置 / 虚拟机创建默认值 / 站点信息 / 系统信息
   ========================================================================== */

import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  configApi,
  healthApi,
  clusterApi,
  connectionsApi,
  mailApi,
  siteApi,
} from '../api/endpoints';
import { errorMessage, isNotImplemented } from '../api/client';
import {
  faqApi,
  defaultSettings,
  loadSettings,
  saveSettings,
} from '../api/endpoints';
import { PageShell } from '../components/Layout';
import { PanelUpdateCard } from '../components/PanelUpdateCard';
import {
  ALWAYS_OPEN_PATHS,
  FOOTER_NAV_ITEMS,
  NAV_SECTIONS,
  isPathDisabled,
} from '../components/Sidebar';
import { DEFAULT_UI_PREFS } from '../hooks/useUiPrefs';
import { useT } from '../i18n';
import { Card, CardHeader, KpiCard } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import {
  Input,
  Select,
  Switch,
  Field,
  Textarea,
  SegmentedControl,
} from '../components/ui/Input';
import {
  ErrorState,
  Notice,
  CollapsibleCard,
} from '../components/ui/EmptyState';
import {
  IconSettings,
  IconRefresh,
  IconShield,
  IconInfo,
  IconCheck,
  IconActivity,
  IconServer,
  IconLayers,
  IconBox,
  IconVm,
  IconSave,
  IconPlus,
  IconTrash,
  IconChevronUp,
  IconChevronDown,
  IconBell,
  IconLink,
  IconMonitor,
  IconMenu,
} from '../components/Icons';
import { formatDateTime } from '../utils/format';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import { useSectionSpy } from '../hooks/useSectionSpy';
import { DEFAULT_SITE_INFO } from '../hooks/useSiteInfo';
import { BrandLogo } from '../components/BrandLogo';
import { ResourceSpecsPanel } from '../components/ResourceSpecsPanel';
import { NodeNoteField, useNodeMeta } from '../components/NodeMeta';
import type {
  ClusterStatus,
  FaqItem,
  HealthStatus,
  LoginCaptchaMode,
  MailConfigInput,
  MailTlsMode,
  PanelSettings,
  SiteInfo,
  SiteLink,
  UiPrefs,
} from '../api/types';

/* ---------------------------------------------------------------------------
   页面
   --------------------------------------------------------------------------- */

/* ==========================================================================
   设置页外壳：吸顶区块导航 + 全宽分组堆叠

   前一版是「横向页签 + 一条 960/1240px 的单列卡片」：页签铺满整个内容区、
   卡片只占左半边，右边永远空一截，跟控制台其它页面（PageShell 不通栏宽度、
   内容靠内部栅格分列）不是一种写法；更麻烦的是一次只显示一个分区，
   分组名在界面上根本不存在 —— 「哪些改的是本机偏好、哪些改的是服务端配置」
   全靠猜。

   现在改成控制台里通用的那套：
     * 整页铺满，不再设宽度上限（与 Dashboard / Profile / Frp 一致）；
     * 8 个分区全部按顺序排下来，用分组标题（面板偏好 / 服务端配置 /
       运行信息）把卡片分段，分组的作用范围直接写在标题旁边；
     * 顶部一条吸顶的区块导航，点一下跳过去，滚动时高亮当前所在分区。

   当前分区仍然放在 URL（?tab=）里：刷新、分享链接、浏览器后退都还能回到原处。
   ========================================================================== */

interface SettingsSection {
  id: string;
  /** 所属分组（文案在组件内按 SettingsGroup 取词） */
  group: SettingsGroup;
  /** 导航项与卡片标题共用的名字，两边必须一致，否则“点了没跳对地方” */
  label: string;
  /** 导航项的 title：一句话说明这一段改的是什么 */
  desc: string;
  icon: ReactNode;
  /** 需要 settings.manage；没有这个权限的用户看不到这一项 */
  adminOnly?: boolean;
  render: () => ReactNode;
}

/** 分组键：面板偏好 / 服务端配置 / 运行信息 */
type SettingsGroup = 'prefs' | 'server' | 'runtime';

/** 分区卡片的 DOM id 前缀：吸顶导航的跳转与高亮都按 `前缀 + 分区 id` 找元素 */
const SECTION_ID_PREFIX = 'section-';

export function Settings() {
  const t = useT();
  const queryClient = useQueryClient();
  const { user, hasPermission } = useAuth();
  const canManage = hasPermission('settings.manage');
  const [searchParams, setSearchParams] = useSearchParams();

  /* ---- 健康检查 ---- */
  const healthQuery = useQuery({
    queryKey: ['health'],
    queryFn: () => healthApi.check(),
    refetchInterval: 15_000,
    retry: 1,
  });

  /* ---- 集群状态 ---- */
  const clusterQuery = useQuery({
    queryKey: ['cluster', 'status'],
    queryFn: () => clusterApi.status(),
    refetchInterval: 30_000,
    retry: 1,
  });

  const groupMeta: Record<SettingsGroup, { label: string; desc: string }> = useMemo(
    () => ({
      prefs: {
        label: t('settings.groupPrefs'),
        desc: t('settings.groupPrefsDesc'),
      },
      server: {
        label: t('settings.groupServer'),
        desc: t('settings.groupServerDesc'),
      },
      runtime: {
        label: t('settings.groupRuntime'),
        desc: t('settings.groupRuntimeDesc'),
      },
    }),
    [t],
  );

  const allSections: SettingsSection[] = [
    {
      id: 'panel',
      group: 'prefs',
      /* 名字取卡片标题本身：导航项与卡片标题不一致时，「点了导航却找不到
         对应卡片」是必然的事 */
      label: t('settings.secPanel'),
      desc: t('settings.secPanelDesc'),
      icon: <IconMonitor size={16} />,
      render: () => <PanelSection />,
    },
    {
      id: 'vm-defaults',
      group: 'prefs',
      label: t('settings.secVmDefaults'),
      desc: t('settings.secVmDefaultsDesc'),
      icon: <IconVm size={16} />,
      adminOnly: true,
      render: () => <VMCreateDefaultsSection />,
    },
    {
      id: 'specs',
      group: 'server',
      label: t('settings.secSpecs'),
      /* 与卡片标题一致：导航项与卡片标题不一样时，用户点了会以为走错了地方 */
      desc: t('settings.secSpecsDesc'),
      icon: <IconBox size={16} />,
      adminOnly: true,
      render: () => <ResourceSpecsPanel />,
    },
    {
      id: 'sidebar',
      group: 'server',
      label: t('settings.secSidebar'),
      desc: t('settings.secSidebarDesc'),
      icon: <IconMenu size={16} />,
      adminOnly: true,
      render: () => <SidebarNavSection />,
    },
    {
      id: 'site',
      group: 'server',
      label: t('settings.secSite'),
      desc: t('settings.secSiteDesc'),
      icon: <IconLayers size={16} />,
      adminOnly: true,
      render: () => <SiteInfoSection />,
    },
    {
      id: 'captcha',
      group: 'server',
      label: t('settings.secCaptcha'),
      desc: t('settings.secCaptchaDesc'),
      icon: <IconShield size={16} />,
      adminOnly: true,
      render: () => <LoginCaptchaSection />,
    },
    {
      id: 'panel-url',
      group: 'server',
      label: t('settings.secPanelUrl'),
      desc: t('settings.secPanelUrlDesc'),
      icon: <IconLink size={16} />,
      adminOnly: true,
      render: () => <PanelUrlSection />,
    },
    {
      id: 'faq',
      group: 'server',
      label: t('settings.secFaq'),
      desc: t('settings.secFaqDesc'),
      icon: <IconInfo size={16} />,
      adminOnly: true,
      render: () => <FaqSection />,
    },
    {
      id: 'mail',
      group: 'server',
      label: t('settings.secMail'),
      desc: t('settings.secMailDesc'),
      icon: <IconBell size={16} />,
      adminOnly: true,
      render: () => <EmailSection />,
    },
    {
      id: 'system',
      group: 'runtime',
      label: t('settings.secSystem'),
      desc: t('settings.secSystemDesc'),
      icon: <IconActivity size={16} />,
      render: () => (
        <SystemSection
          health={healthQuery.data}
          healthLoading={healthQuery.isLoading}
          healthError={healthQuery.error}
          onRetryHealth={() => void healthQuery.refetch()}
          cluster={clusterQuery.data}
          clusterLoading={clusterQuery.isLoading}
          currentUsername={user?.username}
          currentRole={user?.role}
        />
      ),
    },
  ];
  const sections = allSections.filter((item) => !item.adminOnly || canManage);

  const firstId = sections[0]?.id ?? '';
  const wanted = searchParams.get('tab') ?? '';

  /* 导航按顺序分组：同一个 group 的项连续出现，分组标题只在第一项前画一次 */
  const groups: Array<{ name: SettingsGroup; items: SettingsSection[] }> = [];
  for (const item of sections) {
    const last = groups[groups.length - 1];
    if (last && last.name === item.group) last.items.push(item);
    else groups.push({ name: item.group, items: [item] });
  }

  /* 当前高亮哪一项：先按 URL 里的 ?tab=，之后交给滚动位置（见 useSectionSpy）。
     参数指向的分区可能因权限变化消失（刚被撤掉 settings.manage），先确认它还在。 */
  const [active, setActive] = useSectionSpy(
    sections.map((item) => item.id),
    {
      prefix: SECTION_ID_PREFIX,
      initial:
        wanted && sections.some((item) => item.id === wanted) ? wanted : firstId,
    },
  );

  /* ?tab= 指向哪一区就滚到哪一区：带参数进来、以及浏览器后退 / 前进，
     走的都是这一条路。 */
  const deepLinkRef = useRef(true);
  useEffect(() => {
    /* 只有首次进入才补第二次滚动：卡片里的查询数据回来后，上面的分区会长高，
       只滚第一帧容易停在错的位置。之后（用户点击跳转）再补就成了抢滚动条。 */
    const settle = deepLinkRef.current;
    deepLinkRef.current = false;
    if (!wanted) return;
    const el = document.getElementById(`${SECTION_ID_PREFIX}${wanted}`);
    if (!el) return;
    const jump = () => el.scrollIntoView({ block: 'start' });
    requestAnimationFrame(jump);
    if (!settle) return;
    const timer = window.setTimeout(jump, 420);
    return () => window.clearTimeout(timer);
  }, [wanted]);

  const go = (id: string) => {
    setActive(id);
    setSearchParams(id === firstId ? {} : { tab: id });
    /* 点第一个分区时 URL 里本来就没参数，上面的 effect 不会被触发，所以跳转
       动作在这里直接做掉；其余情况重复滚到同一处，等于什么都没发生 */
    document
      .getElementById(`${SECTION_ID_PREFIX}${id}`)
      ?.scrollIntoView({ block: 'start' });
  };

  if (!sections.length) return null;

  return (
    <PageShell
      title={
        <>
          <IconSettings size={20} />
          {t('settings.title')}
        </>
      }
      subtitle={t('settings.subtitle')}
      actions={
        <Button
          variant="secondary"
          icon={<IconRefresh size={15} />}
          onClick={() => {
            void healthQuery.refetch();
            void clusterQuery.refetch();
            void queryClient.invalidateQueries({ queryKey: ['config'] });
          }}
          loading={
            (healthQuery.isFetching && !healthQuery.isLoading) ||
            (clusterQuery.isFetching && !clusterQuery.isLoading)
          }
        >
          {t('common.refresh')}
        </Button>
      }
    >
      {/* Proxmox 连接已整体移到「节点 → 连接配置」子页面，这里不再出现任何入口：
          设置页管的是「面板自己的偏好」，连接管的是「有哪些 PVE 主机可管」。 */}
      <nav className="page-index" aria-label={t('settings.pageAria')}>
        {sections.map((item, index) => (
          <Fragment key={item.id}>
            {/* 分组之间一道竖线：吸顶条只有一行高，再挂分组标题会把它撑成两行 */}
            {index > 0 && sections[index - 1].group !== item.group ? (
              <span className="page-index-sep" aria-hidden="true" />
            ) : null}
            <a
              href={`?tab=${item.id}`}
              className={`page-index-item${item.id === active ? ' is-active' : ''}`}
              aria-current={item.id === active ? 'true' : undefined}
              title={item.desc}
              onClick={(event) => {
                /* 当页跳转：交给 go() 处理，不然会被浏览器当成整页刷新 */
                event.preventDefault();
                go(item.id);
              }}
            >
              {item.icon}
              {item.label}
            </a>
          </Fragment>
        ))}
      </nav>

      {/* 分组标题、分区卡片、上面那条导航都是 .page 的直接子元素（.page 本身
          就是 flex 列 + 20px 间距），不再多套一层容器 */}
      {groups.map((group) => (
        <Fragment key={group.name}>
          <header className="page-section-head">
            <h2 className="page-section-title">{groupMeta[group.name].label}</h2>
            <p className="page-section-desc">{groupMeta[group.name].desc}</p>
          </header>

          {group.items.map((item) => (
            <div
              className="page-block"
              id={`${SECTION_ID_PREFIX}${item.id}`}
              key={item.id}
            >
              {item.render()}
            </div>
          ))}
        </Fragment>
      ))}
    </PageShell>
  );
}

/* ---------------------------------------------------------------------------
   区块 2：面板设置
   --------------------------------------------------------------------------- */

function PanelSection() {
  const t = useT();
  const toast = useToast();

  const refreshOptions = useMemo(
    () => [
      { label: t('settings.refresh5s'), value: '5000' },
      { label: t('settings.refresh10s'), value: '10000' },
      { label: t('settings.refresh30s'), value: '30000' },
      { label: t('settings.refresh60s'), value: '60000' },
      { label: t('settings.refreshOff'), value: '0' },
    ],
    [t],
  );
  const pageSizeOptions = useMemo(
    () => [
      { label: t('settings.pageSize', { n: 10 }), value: '10' },
      { label: t('settings.pageSize', { n: 20 }), value: '20' },
      { label: t('settings.pageSize', { n: 50 }), value: '50' },
      { label: t('settings.pageSize', { n: 100 }), value: '100' },
    ],
    [t],
  );
  const [settings, setSettings] = useState<PanelSettings>(() => loadSettings());
  const [saved, setSaved] = useState<PanelSettings>(() => loadSettings());

  const dirty = useMemo(
    () =>
      settings.refreshInterval !== saved.refreshInterval ||
      settings.pageSize !== saved.pageSize ||
      settings.timezone !== saved.timezone,
    [settings, saved],
  );

  const patch = <K extends keyof PanelSettings>(
    key: K,
    value: PanelSettings[K],
  ) => setSettings((prev) => ({ ...prev, [key]: value }));

  const save = () => {
    const next: PanelSettings = { ...settings };
    saveSettings(next);
    setSaved(next);
    toast.success(t('settings.panelSaved'), t('settings.panelSavedHint'));
    /* 通知其他页面重新读取刷新间隔 */
    window.dispatchEvent(new CustomEvent('ProxCenter:settings-changed'));
  };

  const reset = () => {
    setSettings(defaultSettings);
    saveSettings(defaultSettings);
    setSaved(defaultSettings);
    toast.info(t('settings.panelResetDone'));
    window.dispatchEvent(new CustomEvent('ProxCenter:settings-changed'));
  };

  const timezoneGuess = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <Card>
      <CardHeader
        title={t('settings.panelTitle')}
        subtitle={t('settings.panelSubtitle')}
        icon={<IconSettings size={17} />}
      />

      <div className="dyn-list mt-16">
        <div className="set-form-block-head">
          <span className="set-form-block-icon">
            <IconActivity size={15} />
          </span>
          <span className="set-form-block-title">{t('settings.blockData')}</span>
          <span className="set-form-block-hint">{t('settings.blockDataHint')}</span>
        </div>

        {/* 三个字段并排。原先「数据与展示」占一行、时区又单起一行，末尾那行
            只有一只输入框，右半边整片空着 —— 时区本来就和刷新频率同级。 */}
        <div className="set-grid set-grid--3">
          <Field
            label={t('settings.refreshLabel')}
            hint={t('settings.refreshHint')}
          >
            <Select
              value={String(settings.refreshInterval)}
              onChange={(e) => patch('refreshInterval', Number(e.target.value))}
              options={refreshOptions}
            />
          </Field>

          <Field
            label={t('settings.pageSizeLabel')}
            hint={t('settings.pageSizeHint')}
          >
            <Select
              value={String(settings.pageSize)}
              onChange={(e) => patch('pageSize', Number(e.target.value))}
              options={pageSizeOptions}
            />
          </Field>

          <Field
            label={t('settings.timezoneLabel')}
            hint={t('settings.timezoneHint', { tz: timezoneGuess })}
          >
            <Input
              value={settings.timezone}
              onChange={(e) => patch('timezone', e.target.value)}
              placeholder="Asia/Shanghai"
              className="mono"
              autoComplete="off"
            />
          </Field>
        </div>
      </div>

      <Notice tone="info" title={t('settings.localNoticeTitle')}>
        {t('settings.localNoticePre')}{' '}
        <span className="mono">localStorage.pve_panel_settings</span>
        {t('settings.localNoticePost')}
      </Notice>

      <div className="set-action-bar">
        <Button
          variant="primary"
          icon={<IconSave size={15} />}
          onClick={save}
          disabled={!dirty}
        >
          {t('settings.saveSettings')}
        </Button>
        <Button variant="secondary" onClick={reset}>
          {t('settings.restoreDefault')}
        </Button>
        <span className="set-action-spacer" />
        {dirty ? (
          <span className="fs-sm text-warning">{t('settings.unsaved')}</span>
        ) : null}
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------------------
   区块 3：虚拟机创建默认值（服务端设置，作用于所有用户）
   --------------------------------------------------------------------------- */

function VMCreateDefaultsSection() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('settings.manage');

  const [dns, setDns] = useState('');
  /* 下发总额度用字符串存：空串 = 不限制，与「填了 0」是两回事 */
  const [quotaText, setQuotaText] = useState('');
  const [lxcQuotaText, setLxcQuotaText] = useState('');
  const [busy, setBusy] = useState(false);
  const loadedRef = useRef(false);
  const quotaRef = useRef(false);
  const lxcQuotaRef = useRef(false);

  const query = useQuery({
    queryKey: ['config', 'vm-defaults'],
    queryFn: configApi.getVmDefaults,
    staleTime: 30_000,
    retry: false,
  });

  const quotaQuery = useQuery({
    queryKey: ['config', 'vm-quota'],
    queryFn: configApi.getVmQuota,
    staleTime: 30_000,
    retry: false,
  });

  /* 容器额度：与虚拟机额度各记一份，互不占用 */
  const lxcQuotaQuery = useQuery({
    queryKey: ['config', 'lxc-quota'],
    queryFn: configApi.getLxcQuota,
    staleTime: 30_000,
    retry: false,
  });

  useEffect(() => {
    if (!query.data || loadedRef.current) return;
    loadedRef.current = true;
    setDns(query.data.dns ?? '');
  }, [query.data]);

  useEffect(() => {
    if (!quotaQuery.data || quotaRef.current) return;
    quotaRef.current = true;
    setQuotaText(quotaQuery.data.quota == null ? '' : String(quotaQuery.data.quota));
  }, [quotaQuery.data]);

  useEffect(() => {
    if (!lxcQuotaQuery.data || lxcQuotaRef.current) return;
    lxcQuotaRef.current = true;
    setLxcQuotaText(
      lxcQuotaQuery.data.quota == null ? '' : String(lxcQuotaQuery.data.quota),
    );
  }, [lxcQuotaQuery.data]);

  const save = async () => {
    // 先校验再落库，别出现「DNS 存了、额度没存」这种半截状态
    const text = quotaText.trim();
    const lxcText = lxcQuotaText.trim();
    if (text && !/^\d+$/.test(text)) {
      toast.error(t('settings.vmQuotaVmInt'), t('settings.vmQuotaEmptyHint'));
      return;
    }
    if (lxcText && !/^\d+$/.test(lxcText)) {
      toast.error(t('settings.vmQuotaLxcInt'), t('settings.vmQuotaEmptyHint'));
      return;
    }
    setBusy(true);
    try {
      const saved = await configApi.saveVmDefaults(dns);
      setDns(saved.dns ?? '');
      const savedQuota = await configApi.saveVmQuota(text === '' ? null : Number(text));
      setQuotaText(savedQuota.quota == null ? '' : String(savedQuota.quota));
      const savedLxc = await configApi.saveLxcQuota(
        lxcText === '' ? null : Number(lxcText),
      );
      setLxcQuotaText(savedLxc.quota == null ? '' : String(savedLxc.quota));
      toast.success(
        t('profile.saved'),
        saved.dns
          ? t('settings.vmSavedDns', { dns: saved.dns })
          : t('settings.vmSavedDnsEmpty'),
      );
      void queryClient.invalidateQueries({ queryKey: ['config', 'vm-defaults'] });
      void queryClient.invalidateQueries({ queryKey: ['config', 'vm-quota'] });
      void queryClient.invalidateQueries({ queryKey: ['config', 'lxc-quota'] });
    } catch (err) {
      toast.error(t('common.opFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  /* 已用 / 可下发的实时读数，让管理员填数时知道现在是多少 */
  const quotaUsed = quotaQuery.data?.used ?? 0;
  const quotaRemaining = quotaQuery.data?.remaining ?? null;
  const lxcUsed = lxcQuotaQuery.data?.used ?? 0;
  const lxcRemaining = lxcQuotaQuery.data?.remaining ?? null;

  return (
    <Card>
      <CardHeader
        title={t('settings.vmTitle')}
        subtitle={t('settings.vmSubtitle')}
        icon={<IconServer size={17} />}
        actions={
          <Button
            variant="primary"
            size="sm"
            icon={<IconSave size={14} />}
            loading={busy}
            disabled={!canManage || query.isLoading}
            onClick={() => void save()}
          >
            {t('common.save')}
          </Button>
        }
      />

      {/* 三栏并排：DNS 与两份额度原本各占一整行，每个输入框都被拉满整行宽度，
          下方还跟着一段只在左侧的读数。并排之后一屏就能看完，读数也跟着各自的
          输入框。 */}
      <div className="set-grid set-grid--3 mt-16">
        <div className="set-col">
          <div className="set-form-block-head">
            <span className="set-form-block-icon">
              <IconActivity size={15} />
            </span>
            <span className="set-form-block-title">{t('settings.vmDnsBlock')}</span>
            <span className="set-form-block-hint">{t('settings.vmNoInterfere')}</span>
          </div>

          <Field label={t('settings.vmDnsLabel')} hint={t('settings.vmDnsHint')}>
            <Input
              value={dns}
              onChange={(e) => setDns(e.target.value)}
              placeholder="223.5.5.5 119.29.29.29"
              className="mono"
              autoComplete="off"
              disabled={!canManage}
            />
          </Field>
        </div>

        <div className="set-col">
          <div className="set-form-block-head">
            <span className="set-form-block-icon">
              <IconVm size={15} />
            </span>
            <span className="set-form-block-title">{t('settings.vmVmQuotaBlock')}</span>
            <span className="set-form-block-hint">{t('settings.vmNoLimit')}</span>
          </div>

          <Field
            label={t('settings.vmVmQuotaLabel')}
            hint={t('settings.vmVmQuotaHint')}
          >
            <Input
              value={quotaText}
              onChange={(e) => setQuotaText(e.target.value)}
              placeholder={t('settings.vmPlaceholderNoLimit')}
              className="mono"
              inputMode="numeric"
              autoComplete="off"
              disabled={!canManage}
            />
          </Field>

          {quotaQuery.data ? (
            <div className="set-readout">
              <span>{t('settings.vmUsedVm', { n: quotaUsed })}</span>
              {quotaRemaining != null ? (
                <span>{t('settings.vmRemainingVm', { n: quotaRemaining })}</span>
              ) : null}
              {quotaQuery.data.count_error ? (
                <span className="set-readout-warn">
                  {t('settings.vmCountErrorVm', {
                    err: quotaQuery.data.count_error,
                  })}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* 容器额度：单独一份，与虚拟机额度互不占用。
            原先只有一份总额度且把容器也算进去，于是「限制虚拟机」会连带
            把容器一起锁死，界面上没人说得清额度被谁吃掉了。 */}
        <div className="set-col">
          <div className="set-form-block-head">
            <span className="set-form-block-icon">
              <IconBox size={15} />
            </span>
            <span className="set-form-block-title">{t('settings.vmLxcQuotaBlock')}</span>
            <span className="set-form-block-hint">{t('settings.vmNoLimit')}</span>
          </div>

          <Field
            label={t('settings.vmLxcQuotaLabel')}
            hint={t('settings.vmLxcQuotaHint')}
          >
            <Input
              value={lxcQuotaText}
              onChange={(e) => setLxcQuotaText(e.target.value)}
              placeholder={t('settings.vmPlaceholderNoLimit')}
              className="mono"
              inputMode="numeric"
              autoComplete="off"
              disabled={!canManage}
            />
          </Field>

          {lxcQuotaQuery.data ? (
            <div className="set-readout">
              <span>{t('settings.vmUsedLxc', { n: lxcUsed })}</span>
              {lxcRemaining != null ? (
                <span>{t('settings.vmRemainingLxc', { n: lxcRemaining })}</span>
              ) : null}
              {lxcQuotaQuery.data.count_error ? (
                <span className="set-readout-warn">
                  {t('settings.vmCountErrorLxc', {
                    err: lxcQuotaQuery.data.count_error,
                  })}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {!canManage ? (
        <div className="mt-16">
          <Notice tone="info" title={t('settings.readonlyTitle')}>
            {t('settings.readonlyBody')}
          </Notice>
        </div>
      ) : null}
    </Card>
  );
}

/* ---------------------------------------------------------------------------
   区块 4：站点信息（服务端设置，作用于所有用户）
   --------------------------------------------------------------------------- */

function SiteInfoSection() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('settings.manage');

  const [form, setForm] = useState<SiteInfo>(DEFAULT_SITE_INFO);
  const [busy, setBusy] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  const [bgBusy, setBgBusy] = useState(false);
  const loadedRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const bgFileRef = useRef<HTMLInputElement>(null);

  const query = useQuery({
    queryKey: ['config', 'site'],
    queryFn: siteApi.get,
    staleTime: 30_000,
    retry: false,
  });

  useEffect(() => {
    if (!query.data || loadedRef.current) return;
    loadedRef.current = true;
    setForm(query.data);
  }, [query.data]);

  const patch = <K extends keyof SiteInfo>(key: K, value: SiteInfo[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  /* ---- 友情链接：按行增删改，保存时整体提交 ---- */
  const patchLink = (index: number, key: keyof SiteLink, value: string) =>
    setForm((prev) => ({
      ...prev,
      links: prev.links.map((link, i) =>
        i === index ? { ...link, [key]: value } : link,
      ),
    }));

  const addLink = () =>
    setForm((prev) => ({ ...prev, links: [...prev.links, { name: '', url: '' }] }));

  const removeLink = (index: number) =>
    setForm((prev) => ({
      ...prev,
      links: prev.links.filter((_, i) => i !== index),
    }));

  const save = async () => {
    setBusy(true);
    try {
      const saved = await siteApi.save(form);
      setForm(saved);
      toast.success(
        t('settings.siteSaved'),
        t('settings.siteSavedName', { name: saved.name }),
      );
      void queryClient.invalidateQueries({ queryKey: ['config', 'site'] });
    } catch (err) {
      toast.error(t('common.opFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  /* Logo 独立上传：选完文件立即生效，不走上面的「保存」按钮 */
  const uploadLogo = async (file: File) => {
    setLogoBusy(true);
    try {
      const saved = await siteApi.uploadLogo(file);
      setForm(saved);
      toast.success(t('settings.siteLogoUpdated'), t('settings.siteLogoUpdatedHint'));
      void queryClient.invalidateQueries({ queryKey: ['config', 'site'] });
    } catch (err) {
      toast.error(t('settings.siteUploadFailed'), errorMessage(err));
    } finally {
      setLogoBusy(false);
      // 清空 input，否则连续选同一个文件不会再触发 change
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const resetLogo = async () => {
    setLogoBusy(true);
    try {
      const saved = await siteApi.removeLogo();
      setForm(saved);
      toast.success(t('settings.siteLogoRemoved'), t('settings.siteLogoRemovedHint'));
      void queryClient.invalidateQueries({ queryKey: ['config', 'site'] });
    } catch (err) {
      toast.error(t('settings.siteRemoveFailed'), errorMessage(err));
    } finally {
      setLogoBusy(false);
    }
  };

  /* 登录页背景图：与 Logo 一样独立上传，选完立即生效 */
  const uploadLoginBg = async (file: File) => {
    setBgBusy(true);
    try {
      const saved = await siteApi.uploadLoginBg(file);
      setForm(saved);
      toast.success(t('settings.siteBgUpdated'), t('settings.siteBgUpdatedHint'));
      void queryClient.invalidateQueries({ queryKey: ['config', 'site'] });
    } catch (err) {
      toast.error(t('settings.siteUploadFailed'), errorMessage(err));
    } finally {
      setBgBusy(false);
      // 清空 input，否则连续选同一个文件不会再触发 change
      if (bgFileRef.current) bgFileRef.current.value = '';
    }
  };

  const resetLoginBg = async () => {
    setBgBusy(true);
    try {
      const saved = await siteApi.removeLoginBg();
      setForm(saved);
      toast.success(t('settings.siteBgRemoved'), t('settings.siteBgRemovedHint'));
      void queryClient.invalidateQueries({ queryKey: ['config', 'site'] });
    } catch (err) {
      toast.error(t('settings.siteRemoveFailed'), errorMessage(err));
    } finally {
      setBgBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title={t('settings.siteTitle')}
        subtitle={t('settings.siteSubtitle')}
        icon={<IconInfo size={17} />}
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<IconRefresh size={14} />}
              disabled={!canManage || busy}
              onClick={() => setForm(DEFAULT_SITE_INFO)}
            >
              {t('settings.restoreDefault')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<IconSave size={14} />}
              loading={busy}
              disabled={!canManage || query.isLoading}
              onClick={() => void save()}
            >
              {t('common.save')}
            </Button>
          </>
        }
      />

      {/* 两列铺开：这 7 个字段原先一人一行，站点名称、副标题这类短输入也被
          拉到近千像素宽，卡片右半边整片空着。每个字段外面那层 .dyn-row 交给
          CSS 的 display:contents 拆掉，字段直接落进这个栅格。 */}
      <div className="set-grid mt-16">
        <div className="set-form-block-head">
          <span className="set-form-block-icon">
            <IconSettings size={15} />
          </span>
          <span className="set-form-block-title">{t('settings.siteBrandBlock')}</span>
          <span className="set-form-block-hint">{t('settings.siteBrandBlockHint')}</span>
        </div>

        <div className="dyn-row">
          <Field
            label={t('settings.siteLogoLabel')}
            hint={t('settings.siteLogoHint')}
          >
            <div className="brand-upload">
              <span className="brand-upload-preview">
                {form.logo_url ? (
                  <img src={form.logo_url} alt={t('settings.siteLogoPreviewAlt')} />
                ) : (
                  <BrandLogo size={40} />
                )}
              </span>
              <div className="brand-upload-actions">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/x-icon"
                  className="sr-only"
                  onChange={(e) => {
                    const picked = e.target.files?.[0];
                    if (picked) void uploadLogo(picked);
                  }}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<IconPlus size={14} />}
                  loading={logoBusy}
                  disabled={!canManage}
                  onClick={() => fileRef.current?.click()}
                >
                  {form.logo_url
                    ? t('settings.siteChangeImage')
                    : t('settings.siteUploadImage')}
                </Button>
                {form.logo_url ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<IconTrash size={14} />}
                    disabled={!canManage || logoBusy}
                    onClick={() => void resetLogo()}
                  >
                    {t('settings.siteRestoreBuiltin')}
                  </Button>
                ) : null}
              </div>
            </div>
          </Field>
        </div>

        <div className="dyn-row">
          <Field
            label={t('settings.siteBgLabel')}
            hint={t('settings.siteBgHint')}
          >
            <div className="brand-upload">
              <span className="brand-upload-preview brand-upload-preview--wide">
                {form.login_bg_url ? (
                  <img src={form.login_bg_url} alt={t('settings.siteBgPreviewAlt')} />
                ) : (
                  <span className="fs-xs text-muted">
                    {t('settings.siteBuiltinIllustration')}
                  </span>
                )}
              </span>
              <div className="brand-upload-actions">
                <input
                  ref={bgFileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="sr-only"
                  onChange={(e) => {
                    const picked = e.target.files?.[0];
                    if (picked) void uploadLoginBg(picked);
                  }}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<IconPlus size={14} />}
                  loading={bgBusy}
                  disabled={!canManage}
                  onClick={() => bgFileRef.current?.click()}
                >
                  {form.login_bg_url
                    ? t('settings.siteChangeImage')
                    : t('settings.siteUploadImage')}
                </Button>
                {form.login_bg_url ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<IconTrash size={14} />}
                    disabled={!canManage || bgBusy}
                    onClick={() => void resetLoginBg()}
                  >
                    {t('settings.siteRestoreBuiltin')}
                  </Button>
                ) : null}
              </div>
            </div>
          </Field>
        </div>

        <div className="dyn-row">
          <Field
            label={t('settings.siteNameLabel')}
            hint={t('settings.siteNameHint')}
          >
            <Input
              value={form.name}
              onChange={(e) => patch('name', e.target.value)}
              placeholder={DEFAULT_SITE_INFO.name}
              maxLength={32}
              autoComplete="off"
              disabled={!canManage}
            />
          </Field>
        </div>

        <div className="dyn-row">
          <Field
            label={t('settings.siteSubtitleLabel')}
            hint={t('settings.siteSubtitleHint')}
          >
            <Input
              value={form.subtitle}
              onChange={(e) => patch('subtitle', e.target.value)}
              placeholder={t('site.defaultSubtitle')}
              maxLength={40}
              autoComplete="off"
              disabled={!canManage}
            />
          </Field>
        </div>

        <div className="dyn-row">
          <Field
            label={t('settings.siteCopyrightLabel')}
            hint={t('settings.siteCopyrightHint')}
          >
            <Input
              value={form.copyright}
              onChange={(e) => patch('copyright', e.target.value)}
              placeholder={DEFAULT_SITE_INFO.copyright}
              maxLength={120}
              autoComplete="off"
              disabled={!canManage}
            />
          </Field>
        </div>

        <div className="dyn-row">
          <Field
            label={t('settings.siteIcpLabel')}
            hint={t('settings.siteIcpHint')}
          >
            <Input
              value={form.icp}
              onChange={(e) => patch('icp', e.target.value)}
              placeholder={t('settings.siteIcpPlaceholder')}
              maxLength={64}
              autoComplete="off"
              disabled={!canManage}
            />
          </Field>
        </div>

        <div className="dyn-row">
          <Field
            label={t('settings.siteLinksLabel')}
            className="is-wide"
            hint={t('settings.siteLinksHint')}
          >
            <div className="link-editor">
              {form.links.length === 0 ? (
                <p className="link-editor-empty">{t('settings.siteLinksEmpty')}</p>
              ) : (
                form.links.map((link, index) => (
                  <div className="link-editor-row" key={index}>
                    <Input
                      value={link.name}
                      onChange={(e) => patchLink(index, 'name', e.target.value)}
                      placeholder={t('settings.siteLinkNamePlaceholder')}
                      maxLength={24}
                      autoComplete="off"
                      disabled={!canManage}
                      aria-label={t('settings.siteLinkNameAria', { n: index + 1 })}
                    />
                    <Input
                      value={link.url}
                      onChange={(e) => patchLink(index, 'url', e.target.value)}
                      placeholder="https://example.com"
                      maxLength={300}
                      autoComplete="off"
                      disabled={!canManage}
                      aria-label={t('settings.siteLinkUrlAria', { n: index + 1 })}
                    />
                    <IconButton
                      label={t('settings.siteLinkDeleteAria', { n: index + 1 })}
                      variant="danger"
                      disabled={!canManage}
                      onClick={() => removeLink(index)}
                    >
                      <IconTrash size={15} />
                    </IconButton>
                  </div>
                ))
              )}

              <div className="link-editor-foot">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<IconPlus size={14} />}
                  disabled={!canManage || form.links.length >= 12}
                  onClick={addLink}
                >
                  {t('settings.siteAddLink')}
                </Button>
                <span className="fs-xs text-muted">
                  {t('settings.siteLinksFootHint', { n: form.links.length })}
                </span>
              </div>
            </div>
          </Field>
        </div>

        {!canManage ? (
          <Notice tone="info" title={t('settings.readonlyTitle')}>
            {t('settings.readonlyBody')}
          </Notice>
        ) : null}
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------------------
   区块 4.1：导航栏功能开关（服务端开关，作用于所有用户）
   ---------------------------------------------------------------------------
   导航栏里的每一个入口各一个开关，写进 settings 表、对所有用户立即生效
   （后端见 app/ui.py）。关掉后该入口从导航栏、顶栏头像菜单、Ctrl / ⌘ + K
   全局搜索里一起消失，直接输 URL 也会被弹回一个还开着的页面
   （见 Sidebar.isPathDisabled 与 Layout 里的路由拦截）。

   导航栏本身没有总开关：这里关的始终是「里面的某个功能入口」。整条导航栏
   只剩折叠（每个用户自己那一个收起按钮），不提供成批关闭。

   与「登录验证」同样的交互约定：不设「保存」按钮，点一下即时生效，失败就
   弹回原值（Switch 是受控的，状态只在服务端确认后才改）。

   为什么把入口留在「服务端配置」而不是「面板偏好」：它写进 settings 表、
   对所有用户生效，不是「当前这台浏览器」的偏好。改完立刻作数 —— 不需要
   重启，也不需要用户刷新页面。
   --------------------------------------------------------------------------- */

/** 关不掉的入口：它是重新打开这些开关的唯一地方（见 Sidebar.ALWAYS_OPEN_PATHS） */
const LOCKED_NAV_PATHS = new Set(ALWAYS_OPEN_PATHS);

function SidebarNavSection() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const t = useT();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('settings.manage');

  const [prefs, setPrefs] = useState<UiPrefs>(DEFAULT_UI_PREFS);
  const [busy, setBusy] = useState(false);
  /* 只在首次拿到服务端值时回填，之后不再覆盖用户正在操作的开关 */
  const loadedRef = useRef(false);

  const query = useQuery({
    queryKey: ['config', 'ui'],
    queryFn: configApi.getUiPrefs,
    staleTime: 30_000,
    retry: false,
  });

  useEffect(() => {
    if (!query.data || loadedRef.current) return;
    loadedRef.current = true;
    setPrefs(query.data);
  }, [query.data]);

  /* 整份提交：后端对缺省字段的处理是「保持原值」，只发半份状态容易两边
     各改一半、互相覆盖。 */
  const save = async (next: UiPrefs, okTitle: string, okHint: string) => {
    if (!canManage || busy) return;
    setBusy(true);
    try {
      const saved = await configApi.saveUiPrefs(next);
      setPrefs(saved);
      /* 控制台外壳（Layout）、侧边栏、顶栏菜单、命令面板读的都是同一份
         query：当场写回，开关一按各处立刻跟着变，不用等它自己过期。 */
      queryClient.setQueryData(['config', 'ui'], saved);
      void queryClient.invalidateQueries({ queryKey: ['config', 'ui'] });
      toast.success(okTitle, okHint);
    } catch (err) {
      /* 失败时不动 prefs：Switch 是受控的，会自己弹回原值 */
      toast.error(t('common.opFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleItem = (to: string, label: string, next: boolean) =>
    void save(
      {
        ...prefs,
        nav_disabled: next
          ? prefs.nav_disabled.filter((path) => path !== to)
          : [...prefs.nav_disabled, to],
      },
      next
        ? t('settings.navOnToast', { label })
        : t('settings.navOffToast', { label }),
      next ? t('settings.navOnHint') : t('settings.navOffHint'),
    );

  /* 分组与顺序直接取侧边栏那一份（末尾补上底部账号区的项）：设置页看到的
     分组必须和用户在侧边栏里看到的一致，另维护一份清单迟早会对不上。 */
  const groups = [
    ...NAV_SECTIONS.map((section) => ({
      titleKey: section.titleKey,
      items: section.items,
    })),
    { titleKey: 'settings.nav.sectionAccount' as const, items: FOOTER_NAV_ITEMS },
  ];

  const closedCount = prefs.nav_disabled.length;

  return (
    <Card>
      <CardHeader
        title={t('settings.navTitle')}
        subtitle={t('settings.navSubtitle')}
        icon={<IconMenu size={17} />}
        actions={
          busy ? (
            <Badge variant="info" size="sm">
              {t('settings.navSaving')}
            </Badge>
          ) : undefined
        }
      />

      {/* 逐项开关：分组与顺序与侧边栏完全一致 */}
      {groups.map((group) => {
        const closed = group.items.filter((item) =>
          isPathDisabled(item.to, prefs.nav_disabled),
        ).length;
        return (
          <div className="dyn-list mt-16" key={group.titleKey}>
            <div className="set-form-block-head">
              <span className="set-form-block-icon">
                <IconMenu size={15} />
              </span>
              <span className="set-form-block-title">{t(group.titleKey)}</span>
              <span className="set-form-block-hint">
                {closed > 0
                  ? t('settings.navClosedCount', { n: closed })
                  : t('settings.navAllOpen')}
              </span>
            </div>

            <div className="set-grid set-grid--3">
              {group.items.map((item) => {
                /* 恢复入口不能关：关掉之后界面上再没有地方能把这些开关打开 */
                const locked = LOCKED_NAV_PATHS.has(item.to);
                const label = t(item.labelKey);
                return (
                  <Switch
                    key={item.to}
                    checked={!isPathDisabled(item.to, prefs.nav_disabled)}
                    onChange={(next) => toggleItem(item.to, label, next)}
                    disabled={!canManage || busy || locked}
                    label={label}
                    hint={locked ? t('settings.navLockedHint') : item.to}
                    ariaLabel={t('settings.navItemAria', { label })}
                  />
                );
              })}
            </div>
          </div>
        );
      })}

      <Notice tone="info" title={t('settings.navNoticeTitle')}>
        {t('settings.navNoticeBody')}
      </Notice>

      {closedCount > 0 ? (
        <div className="set-action-bar">
          <Button
            variant="secondary"
            onClick={() =>
              void save(
                { ...prefs, nav_disabled: [] },
                t('settings.navRestoredAll'),
                t('settings.navRestoredAllHint'),
              )
            }
            disabled={!canManage || busy}
          >
            {t('settings.navRestoreAll')}
          </Button>
          <span className="set-action-spacer" />
          <span className="fs-sm text-warning">
            {t('settings.navClosedEntries', { n: closedCount })}
          </span>
        </div>
      ) : null}

      {!canManage ? (
        <div className="mt-16">
          <Notice tone="info" title={t('settings.readonlyTitle')}>
            {t('settings.readonlyBody')}
          </Notice>
        </div>
      ) : null}
    </Card>
  );
}

/* ---------------------------------------------------------------------------
   区块 4.5：登录验证方式（服务端设置，作用于登录页）
   ---------------------------------------------------------------------------
   三档：关闭 / 拖动滑块（默认） / 图形验证码。

   改这个设置等于改「别人能不能登进来」：把验证码关掉之后，登录接口只剩
   「失败次数锁定」一道防线，爆破脚本可以直接对着密码猜。所以后端在写入时
   要求二次确认（step_up），前端这里只要照常调用即可 —— 403 + X-Step-Up
   会被 axios 拦截器接成一次弹框，验完自动重放。

   交互上刻意不设「保存」按钮：三选一本来就是个开关，点一下即时生效、
   失败就把选中项弹回原值，比「选完再点保存」少一步。
   --------------------------------------------------------------------------- */

/* 顺序与默认值一致：没配过时后端给的就是「拖动滑块」（见 backend/app/captcha.py） */

function LoginCaptchaSection() {
  const t = useT();
  const toast = useToast();

  const captchaOptions = useMemo(
    () => [
      { label: t('settings.captchaOptOff'), value: 'off' as LoginCaptchaMode },
      { label: t('settings.captchaOptSlider'), value: 'slider' as LoginCaptchaMode },
      { label: t('settings.captchaOptImage'), value: 'image' as LoginCaptchaMode },
    ],
    [t],
  );
  const captchaHint = useMemo<Record<LoginCaptchaMode, string>>(
    () => ({
      off: t('settings.captchaHintOff'),
      image: t('settings.captchaHintImage'),
      slider: t('settings.captchaHintSlider'),
    }),
    [t],
  );
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('settings.manage');

  const [mode, setMode] = useState<LoginCaptchaMode>('image');
  const [busy, setBusy] = useState(false);
  /* 只在首次拿到服务端值时回填，之后再渲染不能被覆盖掉（用户可能正在切换） */
  const loadedRef = useRef(false);

  const query = useQuery({
    queryKey: ['config', 'login-captcha'],
    queryFn: configApi.getLoginCaptcha,
    staleTime: 30_000,
    retry: false,
  });

  useEffect(() => {
    if (!query.data || loadedRef.current) return;
    loadedRef.current = true;
    setMode(query.data.mode);
  }, [query.data]);

  const save = async (next: LoginCaptchaMode) => {
    if (!canManage || busy || next === mode) return;
    setBusy(true);
    try {
      const saved = await configApi.saveLoginCaptcha(next);
      setMode(saved.mode);
      /* 登录页缓存的挑战是按旧方式签发的：不清掉的话，「退出 → 再登录」
         会拿着上一种方式的挑战去提交（图形码的 id 配滑块的 x）。 */
      queryClient.removeQueries({ queryKey: ['login-captcha'] });
      void queryClient.invalidateQueries({ queryKey: ['config', 'login-captcha'] });
      toast.success(t('settings.captchaUpdated'), captchaHint[saved.mode]);
    } catch (err) {
      // 失败时不动 mode：SegmentedControl 是受控的，会自己弹回原值
      toast.error(t('common.opFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title={t('settings.captchaTitle')}
        subtitle={t('settings.captchaSubtitle')}
        icon={<IconShield size={17} />}
        actions={
          busy ? (
            <Badge variant="info" size="sm">
              {t('settings.navSaving')}
            </Badge>
          ) : undefined
        }
      />

      {/* 左边选、右边把三种方式摊开对比：原来一个分段控件孤零零占一整行，
          卡片下半截全是空的，而「选了另外两种会怎样」只能靠一句 hint 猜。 */}
      <div className="set-cols mt-16">
        <div className="set-col">
          <div className="set-form-block-head">
            <span className="set-form-block-icon">
              <IconShield size={15} />
            </span>
            <span className="set-form-block-title">{t('settings.captchaModeBlock')}</span>
            <span className="set-form-block-hint">
              {t('settings.captchaModeBlockHint')}
            </span>
          </div>

          <Field
            label={t('settings.captchaModeLabel')}
            hint={t('settings.captchaModeHint')}
          >
            <SegmentedControl<LoginCaptchaMode>
              value={mode}
              onChange={(next) => void save(next)}
              ariaLabel={t('settings.captchaModeAria')}
              options={captchaOptions}
            />
          </Field>

          {mode === 'off' ? (
            <Notice tone="warning" title={t('settings.captchaOffTitle')}>
              {t('settings.captchaOffBody')}
            </Notice>
          ) : null}
        </div>

        <div className="set-col">
          <div className="set-form-block-head">
            <span className="set-form-block-icon">
              <IconInfo size={15} />
            </span>
            <span className="set-form-block-title">
              {t('settings.captchaCompareBlock')}
            </span>
            <span className="set-form-block-hint">
              {t('settings.captchaCompareHint')}
            </span>
          </div>

          <ul className="set-option-list">
            {captchaOptions.map((option) => (
              <li
                key={option.value}
                className={`set-option${option.value === mode ? ' is-active' : ''}`}
              >
                <span className="set-option-mark" aria-hidden="true">
                  <IconCheck size={13} />
                </span>
                <span className="set-option-text">
                  <span className="set-option-name">{option.label}</span>
                  <span>{captchaHint[option.value]}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {!canManage ? (
        <div className="mt-16">
          <Notice tone="info" title={t('settings.readonlyTitle')}>
            {t('settings.readonlyBody')}
          </Notice>
        </div>
      ) : null}
    </Card>
  );
}

/* ---------------------------------------------------------------------------
   区块 4.3：面板全局地址（邮件 / 飞书回调里拼链接用的外部域名）
   --------------------------------------------------------------------------- */

function PanelUrlSection() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('settings.manage');

  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const loadedRef = useRef(false);

  const query = useQuery({
    queryKey: ['config', 'panel-url'],
    queryFn: configApi.getPanelUrl,
    staleTime: 30_000,
    retry: false,
  });

  useEffect(() => {
    if (!query.data || loadedRef.current) return;
    loadedRef.current = true;
    setUrl(query.data.url ?? '');
  }, [query.data]);

  const save = async () => {
    setBusy(true);
    try {
      const saved = await configApi.savePanelUrl(url.trim());
      setUrl(saved.url);
      toast.success(
        t('settings.urlSaved'),
        saved.url
          ? t('settings.urlSavedHint', { url: saved.url })
          : t('settings.urlCleared'),
      );
      void queryClient.invalidateQueries({ queryKey: ['config', 'panel-url'] });
    } catch (err) {
      toast.error(t('common.opFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  /* 这段地址会被拼进邮件正文与飞书回调，填错只有收件人那端才看得出来 ——
     所以直接把「生效之后链接长什么样」摊在右边给管理员核对。
     留空时用的就是后端那套回落规则：本次请求的 Host。 */
  const base = (url.trim() || window.location.origin).replace(/\/+$/, '');

  return (
    <Card>
      <CardHeader
        title={t('settings.urlTitle')}
        subtitle={t('settings.urlSubtitle')}
        icon={<IconLayers size={17} />}
        actions={
          <Button
            variant="primary"
            size="sm"
            icon={<IconSave size={14} />}
            loading={busy}
            disabled={!canManage || query.isLoading}
            onClick={() => void save()}
          >
            {t('common.save')}
          </Button>
        }
      />

      <div className="set-cols mt-16">
        <div className="set-col">
          <div className="set-form-block-head">
            <span className="set-form-block-icon">
              <IconLink size={15} />
            </span>
            <span className="set-form-block-title">{t('settings.urlBlockTitle')}</span>
            <span className="set-form-block-hint">{t('settings.urlBlockHint')}</span>
          </div>

          <Field label={t('settings.urlLabel')} hint={t('settings.urlHint')}>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://prox.yjscloud.com"
              className="mono"
              autoComplete="off"
              disabled={!canManage}
            />
          </Field>
        </div>

        <div className="set-col">
          <div className="set-form-block-head">
            <span className="set-form-block-icon">
              <IconLink size={15} />
            </span>
            <span className="set-form-block-title">{t('settings.urlPreviewBlock')}</span>
            <span className="set-form-block-hint">
              {url.trim() ? t('settings.urlPreviewFilled') : t('settings.urlPreviewFallback')}
            </span>
          </div>

          <div className="set-preview">
            <div className="set-preview-row">
              <span className="set-preview-label">{t('settings.urlPreviewReset')}</span>
              <span className="set-preview-url">{base}/reset-password?token=…</span>
            </div>
            <div className="set-preview-row">
              <span className="set-preview-label">{t('settings.urlPreviewFeishu')}</span>
              <span className="set-preview-url">{base}/api/feishu/event</span>
            </div>
            <div className="set-preview-row">
              <span className="set-preview-label">{t('settings.urlPreviewHost')}</span>
              <span className="set-preview-url">{window.location.origin}</span>
            </div>
          </div>
        </div>
      </div>

      {!canManage ? (
        <div className="mt-16">
          <Notice tone="info" title={t('settings.readonlyTitle')}>
            {t('settings.readonlyBody')}
          </Notice>
        </div>
      ) : null}
    </Card>
  );
}

/* ---------------------------------------------------------------------------
   区块 5：常见问题（服务端设置，作用于产品官网）
   --------------------------------------------------------------------------- */

function FaqSection() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('settings.manage');

  const [items, setItems] = useState<FaqItem[]>([]);
  const [busy, setBusy] = useState(false);
  const loadedRef = useRef(false);

  const query = useQuery({
    queryKey: ['config', 'faq'],
    queryFn: faqApi.get,
    staleTime: 30_000,
    retry: false,
  });

  useEffect(() => {
    if (!query.data || loadedRef.current) return;
    loadedRef.current = true;
    setItems(query.data);
  }, [query.data]);

  const patchItem = (index: number, key: keyof FaqItem, value: string) =>
    setItems((prev) =>
      prev.map((item, i) => (i === index ? { ...item, [key]: value } : item)),
    );

  const addItem = () => setItems((prev) => [...prev, { q: '', a: '' }]);

  const removeItem = (index: number) =>
    setItems((prev) => prev.filter((_, i) => i !== index));

  /* 上移/下移：顺序就是官网上的展示顺序，用箭头按钮调比拖拽简单可靠 */
  const moveItem = (index: number, delta: number) =>
    setItems((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  const save = async () => {
    setBusy(true);
    try {
      const saved = await faqApi.save(items);
      setItems(saved);
      toast.success(
        t('settings.faqSaved'),
        t('settings.faqSavedCount', { n: saved.length }),
      );
      void queryClient.invalidateQueries({ queryKey: ['config', 'faq'] });
    } catch (err) {
      toast.error(t('common.opFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      const restored = await faqApi.reset();
      setItems(restored);
      toast.success(
        t('settings.faqResetDone'),
        t('settings.faqSavedCount', { n: restored.length }),
      );
      void queryClient.invalidateQueries({ queryKey: ['config', 'faq'] });
    } catch (err) {
      toast.error(t('settings.faqResetFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title={t('settings.faqTitle')}
        subtitle={t('settings.faqSubtitle')}
        icon={<IconInfo size={17} />}
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<IconRefresh size={14} />}
              disabled={!canManage || busy}
              onClick={() => void reset()}
            >
              {t('settings.restoreDefault')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<IconSave size={14} />}
              loading={busy}
              disabled={!canManage || query.isLoading}
              onClick={() => void save()}
            >
              {t('common.save')}
            </Button>
          </>
        }
      />

      <div className="dyn-list mt-16">
        <div className="set-form-block-head">
          <span className="set-form-block-icon">
            <IconSettings size={15} />
          </span>
          <span className="set-form-block-title">{t('settings.faqBlock')}</span>
          <span className="set-form-block-hint">{t('settings.faqBlockHint')}</span>
        </div>

        {items.length === 0 ? (
          <p className="link-editor-empty">{t('settings.faqEmpty')}</p>
        ) : (
          items.map((item, index) => (
            <div className="faq-editor-item" key={index}>
              <div className="faq-editor-head">
                <span className="faq-editor-index mono">#{index + 1}</span>
                <div className="faq-editor-tools">
                  <IconButton
                    label={t('settings.faqMoveUpAria', { n: index + 1 })}
                    disabled={!canManage || index === 0}
                    onClick={() => moveItem(index, -1)}
                  >
                    <IconChevronUp size={14} />
                  </IconButton>
                  <IconButton
                    label={t('settings.faqMoveDownAria', { n: index + 1 })}
                    disabled={!canManage || index === items.length - 1}
                    onClick={() => moveItem(index, 1)}
                  >
                    <IconChevronDown size={14} />
                  </IconButton>
                  <IconButton
                    label={t('settings.faqDeleteAria', { n: index + 1 })}
                    variant="danger"
                    disabled={!canManage}
                    onClick={() => removeItem(index)}
                  >
                    <IconTrash size={14} />
                  </IconButton>
                </div>
              </div>

              <Input
                value={item.q}
                onChange={(e) => patchItem(index, 'q', e.target.value)}
                placeholder={t('settings.faqQPlaceholder')}
                maxLength={200}
                autoComplete="off"
                disabled={!canManage}
                aria-label={t('settings.faqQAria', { n: index + 1 })}
              />
              <Textarea
                value={item.a}
                onChange={(e) => patchItem(index, 'a', e.target.value)}
                placeholder={t('settings.faqAPlaceholder')}
                rows={3}
                maxLength={2000}
                disabled={!canManage}
                aria-label={t('settings.faqAAria', { n: index + 1 })}
              />
            </div>
          ))
        )}

        <div className="link-editor-foot">
          <Button
            variant="secondary"
            size="sm"
            icon={<IconPlus size={14} />}
            disabled={!canManage || items.length >= 30}
            onClick={addItem}
          >
            {t('settings.faqAdd')}
          </Button>
          <span className="fs-xs text-muted">
            {t('settings.faqFootHint', { n: items.length })}
          </span>
        </div>

        {!canManage ? (
          <Notice tone="info" title={t('settings.readonlyTitle')}>
            {t('settings.readonlyBody')}
          </Notice>
        ) : null}
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------------------
   区块 6：系统信息
   --------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
   邮件通知（SMTP）
   --------------------------------------------------------------------------- */

const MAIL_FORM_DEFAULT: MailConfigInput = {
  enabled: true,
  host: '',
  port: 587,
  tls: 'starttls',
  username: '',
  sender: '',
  sender_name: '',
  verify_ssl: true,
  admin_recipients: '',
};

function EmailSection() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('settings.manage');

  const [form, setForm] = useState<MailConfigInput>({ ...MAIL_FORM_DEFAULT });
  const [password, setPassword] = useState('');
  const [passwordClear, setPasswordClear] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const loadedRef = useRef(false);

  const query = useQuery({
    queryKey: ['config', 'mail'],
    queryFn: mailApi.get,
    staleTime: 30_000,
    retry: false,
  });

  useEffect(() => {
    if (!query.data || loadedRef.current) return;
    loadedRef.current = true;
    const cfg = query.data;
    setForm({
      enabled: cfg.enabled,
      host: cfg.host,
      port: cfg.port,
      tls: cfg.tls,
      username: cfg.username,
      sender: cfg.sender,
      sender_name: cfg.sender_name,
      verify_ssl: cfg.verify_ssl,
      admin_recipients: cfg.admin_recipients,
    });
  }, [query.data]);

  const patch = (key: keyof MailConfigInput, value: unknown) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    setBusy(true);
    try {
      const saved = await mailApi.save({
        ...form,
        password: password || undefined,
        password_clear: passwordClear,
      });
      // 密码不回传，保存后清空本地输入
      setPassword('');
      setPasswordClear(false);
      loadedRef.current = false;
      toast.success(
        t('settings.mailSaved'),
        saved.configured
          ? t('settings.mailSavedReady')
          : t('settings.mailSavedIncomplete'),
      );
      void queryClient.invalidateQueries({ queryKey: ['config', 'mail'] });
    } catch (err) {
      toast.error(t('common.opFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const res = await mailApi.test(testTo.trim());
      toast.success(t('settings.mailTestSent'), res.detail);
    } catch (err) {
      toast.error(t('settings.mailTestFailed'), errorMessage(err));
    } finally {
      setTesting(false);
    }
  };

  const passwordSet = query.data?.password_set ?? false;
  const configured = query.data?.configured ?? false;

  /* 端口与加密方式必须配对，否则 TCP 能连上但双方互相等对方先开口，
     最终表现为「10 秒后超时」—— 报错完全看不出原因，很难自己排查出来。 */
  const tlsMismatch = useMemo(() => {
    const port = Number(form.port);
    const mode = form.tls ?? 'starttls';
    if (port === 465 && mode !== 'ssl') {
      return t('settings.mailTlsMismatch465');
    }
    if (port === 587 && mode === 'ssl') {
      return t('settings.mailTlsMismatch587');
    }
    if (port === 25 && mode === 'ssl') {
      return t('settings.mailTlsMismatch25');
    }
    return '';
  }, [form.port, form.tls, t]);



  return (
    <Card>
      <CardHeader
        title={t('settings.mailTitle')}
        subtitle={t('settings.mailSubtitle')}
        icon={<IconBell size={17} />}
        actions={
          <>
            <Badge variant={configured ? 'success' : 'neutral'} dot size="sm">
              {query.isLoading
                ? t('settings.mailStateLoading')
                : configured
                  ? t('settings.mailStateReady')
                  : t('settings.mailStateUnset')}
            </Badge>
            <Button
              variant="primary"
              size="sm"
              icon={<IconSave size={14} />}
              loading={busy}
              disabled={!canManage || query.isLoading}
              onClick={() => void save()}
            >
              {t('common.save')}
            </Button>
          </>
        }
      />

      {!canManage ? (
        <div className="mb-16">
          <Notice tone="info" title={t('settings.readonlyTitle')}>
            {t('settings.mailReadonlyBody')}
          </Notice>
        </div>
      ) : null}

      <div className="flex flex-col gap-16">
        <Switch
          checked={Boolean(form.enabled)}
          onChange={(v) => patch('enabled', v)}
          label={t('settings.mailEnableLabel')}
          hint={t('settings.mailEnableHint')}
          disabled={!canManage}
        />

        <div className="form-grid-2">
          <Field
            label={t('settings.mailHostLabel')}
            required
            hint={t('settings.mailHostHint')}
          >
            <Input
              value={form.host ?? ''}
              onChange={(e) => patch('host', e.target.value)}
              placeholder="smtp.example.com"
              mono
              disabled={!canManage}
            />
          </Field>
          <Field label={t('settings.mailPortLabel')} hint={t('settings.mailPortHint')}>
            <Input
              value={String(form.port ?? '')}
              onChange={(e) => patch('port', Number(e.target.value) || 0)}
              mono
              disabled={!canManage}
            />
          </Field>
        </div>

        <div className="form-grid-2">
          <Field
            label={t('settings.mailTlsLabel')}
            error={tlsMismatch || undefined}
            hint={t('settings.mailTlsHint')}
          >
            <Select
              value={form.tls ?? 'starttls'}
              onChange={(e) => patch('tls', e.target.value as MailTlsMode)}
              options={[
                { label: t('settings.mailTlsStarttls'), value: 'starttls' },
                { label: t('settings.mailTlsSsl'), value: 'ssl' },
                { label: t('settings.mailTlsNone'), value: 'none' },
              ]}
              disabled={!canManage}
            />
          </Field>
          <Field
            label={t('settings.mailUsernameLabel')}
            hint={t('settings.mailUsernameHint')}
          >
            <Input
              value={form.username ?? ''}
              onChange={(e) => patch('username', e.target.value)}
              placeholder={t('settings.mailOptional')}
              autoComplete="off"
              disabled={!canManage}
            />
          </Field>
        </div>

        <Field
          label={t('settings.mailPasswordLabel')}
          hint={
            passwordSet
              ? t('settings.mailPasswordSetHint')
              : t('settings.mailPasswordUnsetHint')
          }
        >
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={
              passwordSet
                ? t('settings.mailPasswordPlaceholderSet')
                : t('settings.mailOptional')
            }
            autoComplete="new-password"
            disabled={!canManage}
          />
        </Field>

        {passwordSet ? (
          <Switch
            checked={passwordClear}
            onChange={setPasswordClear}
            label={t('settings.mailClearPassword')}
            hint={t('settings.mailClearPasswordHint')}
            disabled={!canManage}
          />
        ) : null}

        <div className="form-grid-2">
          <Field
            label={t('settings.mailSenderLabel')}
            hint={t('settings.mailSenderHint')}
          >
            <Input
              value={form.sender ?? ''}
              onChange={(e) => patch('sender', e.target.value)}
              placeholder="noreply@example.com"
              mono
              disabled={!canManage}
            />
          </Field>
          <Field
            label={t('settings.mailSenderNameLabel')}
            hint={t('settings.mailSenderNameHint')}
          >
            <Input
              value={form.sender_name ?? ''}
              onChange={(e) => patch('sender_name', e.target.value)}
              placeholder="ProxCenter"
              disabled={!canManage}
            />
          </Field>
        </div>

        <Switch
          checked={form.verify_ssl !== false}
          onChange={(v) => patch('verify_ssl', v)}
          label={t('settings.mailVerifySsl')}
          hint={t('settings.mailVerifySslHint')}
          disabled={!canManage}
        />

        <Field
          label={t('settings.mailAdminRecipientsLabel')}
          hint={t('settings.mailAdminRecipientsHint')}
        >
          <Input
            value={form.admin_recipients ?? ''}
            onChange={(e) => patch('admin_recipients', e.target.value)}
            placeholder="ops@example.com, admin@example.com"
            mono
            disabled={!canManage}
          />
        </Field>

        <Notice tone="info" title={t('settings.mailWhoTitle')}>
          {t('settings.mailWhoPre')}
          <b>{t('settings.mailWhoStrong')}</b>
          {t('settings.mailWhoPost')}
        </Notice>

        <div className="set-form-block">
          <div className="set-form-block-head">
            <span className="set-form-block-title">{t('settings.mailTestBlock')}</span>
            <span className="set-form-block-hint">
              {t('settings.mailTestBlockHint')}
            </span>
          </div>
          {/* 按钮紧贴收件人输入框右侧。
              标签 / 说明交给 Field，按钮与输入框一起放进行容器 —— 两者都是
              34px 高，居中对齐天然成立，不用像早先那样塞一个空 label 撑位置。 */}
          <Field
            label={t('settings.mailTestToLabel')}
            hint={t('settings.mailTestToHint')}
          >
            <div className="set-input-action">
              <Input
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                placeholder={t('settings.mailTestToPlaceholder')}
                mono
                disabled={!canManage}
              />
              <Button
                variant="secondary"
                icon={<IconBell size={15} />}
                loading={testing}
                disabled={!canManage}
                onClick={() => void sendTest()}
              >
                {t('settings.mailSendTest')}
              </Button>
            </div>
          </Field>
        </div>
      </div>
    </Card>
  );
}

function SystemSection({
  health,
  healthLoading,
  healthError,
  onRetryHealth,
  cluster,
  clusterLoading,
  currentUsername,
  currentRole,
}: {
  health: HealthStatus | undefined;
  healthLoading: boolean;
  healthError: unknown;
  onRetryHealth: () => void;
  cluster: ClusterStatus | undefined;
  clusterLoading: boolean;
  currentUsername?: string;
  currentRole?: string;
}) {
  const t = useT();
  const { isAdmin } = useAuth();
  const [lastChecked, setLastChecked] = useState<Date>(() => new Date());

  /* 全站合计：`/health` 与 `/cluster/status` 都只能读「默认连接」那一套 PVE，
     多连接部署下它们的节点数只是其中一台的 —— 系统信息要给的是**所有连接合计**，
     否则「集群有 4 台、这里显示 1 个节点」就成了误导。 */
  const fleet = useQuery({
    queryKey: ['cluster', 'fleet-status'],
    queryFn: clusterApi.fleetStatus,
    staleTime: 30_000,
    retry: false,
  });
  const totals = fleet.data?.totals;

  /*
    默认读取的那一套 PVE：少数接口（健康探活、/cluster/status）一次只能读一台，
    需要一个确定目标。后端会自己挑一条，但多套 PVE 里「挑哪一套」必须由人决定 ——
    否则「这里怎么只显示 1 个节点」是一个没人答得上的问题。
    注意它**不等于**「主连接」：其余连接照样同级，这里只是给单台读取接口指定目标。
  */
  const queryClient = useQueryClient();
  const toast = useToast();
  const connectionsQuery = useQuery({
    queryKey: ['connections'],
    queryFn: connectionsApi.list,
    staleTime: 300_000,
    retry: false,
    enabled: isAdmin,
  });
  const [switching, setSwitching] = useState(false);
  const conns = connectionsQuery.data ?? [];
  const defaultId = conns.find((item) => item.active)?.id ?? '';
  const defaultName =
    conns.find((item) => item.id === defaultId)?.name ||
    fleet.data?.default_connection?.name ||
    '';

  const pickDefault = async (id: string) => {
    if (!id || id === defaultId) return;
    setSwitching(true);
    try {
      await connectionsApi.activate(id);
      const picked = conns.find((item) => item.id === id);
      toast.success(
        t('settings.systemSwitched'),
        t('settings.systemSwitchedHint', { name: picked?.name || id }),
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['connections'] }),
        queryClient.invalidateQueries({ queryKey: ['cluster', 'status'] }),
        queryClient.invalidateQueries({ queryKey: ['cluster', 'fleet-status'] }),
        queryClient.invalidateQueries({ queryKey: ['health'] }),
      ]);
      onRetryHealth();
    } catch (err) {
      toast.error(t('settings.systemSwitchFailed'), errorMessage(err));
    } finally {
      setSwitching(false);
    }
  };

  useEffect(() => {
    if (!healthLoading) setLastChecked(new Date());
  }, [healthLoading, health]);

  const connected = health?.pve_connected ?? false;

  if (healthError && isNotImplemented(healthError)) {
    return (
      <Card>
        <CardHeader
          title={t('settings.systemTitle')}
          subtitle={t('settings.systemSubtitleHealth')}
          icon={<IconActivity size={17} />}
        />
        <ErrorState
          notImplemented
          title={t('settings.systemNotImplTitle')}
          message={t('settings.systemNotImplMsg')}
          onRetry={onRetryHealth}
        />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title={t('settings.systemTitle')}
        subtitle={t('settings.systemLastChecked', {
          time: formatDateTime(lastChecked),
        })}
        icon={<IconActivity size={17} />}
        actions={
          <>
            <Badge
              variant={connected ? 'success' : 'danger'}
              dot
              pulse={connected}
              size="sm"
            >
              {healthLoading
                ? t('settings.systemChecking')
                : connected
                  ? t('settings.systemConnected')
                  : t('settings.systemUnreachable')}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              icon={<IconRefresh size={14} />}
              onClick={onRetryHealth}
              loading={healthLoading}
            >
              {t('settings.systemRecheck')}
            </Button>
          </>
        }
      />

      <div className="set-kpi-grid mt-16">
        <KpiCard
          label={t('settings.systemKpiPanel')}
          value={health?.status ?? '—'}
          icon={<IconShield size={18} />}
          tone={
            health?.status === 'ok' || health?.status === 'healthy'
              ? 'success'
              : 'neutral'
          }
          loading={healthLoading}
        />
        <KpiCard
          label={t('settings.systemKpiVersion')}
          value={health?.pve_version || cluster?.version || '—'}
          hint={
            health?.pve_connected
              ? t('settings.systemConnectedHint')
              : t('settings.systemNotConnectedHint')
          }
          icon={<IconServer size={18} />}
          tone="accent"
          loading={healthLoading || clusterLoading}
        />
        <KpiCard
          label={
            totals ? t('settings.systemKpiNodesFleet') : t('settings.systemKpiNodes')
          }
          value={totals ? totals.nodes : (cluster?.nodes.length ?? '—')}
          hint={
            totals
              ? t('settings.systemConnectionsOnline', {
                  online: totals.online,
                  total: totals.connections,
                })
              : cluster
                ? cluster.quorate === true
                  ? t('settings.systemQuorate')
                  : cluster.quorate === false
                    ? t('settings.systemNoQuorum')
                    : t('settings.systemStandalone')
                : undefined
          }
          icon={<IconLayers size={18} />}
          tone={
            totals
              ? totals.no_quorum > 0 || totals.online === 0
                ? 'danger'
                : totals.online < totals.connections
                  ? 'warning'
                  : 'success'
              : cluster
                ? cluster.quorate === false
                  ? 'danger'
                  : cluster.quorate === true
                    ? 'success'
                    : 'neutral'
                : 'neutral'
          }
          loading={clusterLoading || fleet.isLoading}
        />
        <KpiCard
          label={t('settings.systemKpiConnections')}
          value={totals ? totals.connections : '—'}
          hint={
            totals
              ? t('settings.systemConnSummary', {
                  clusters: totals.clusters,
                  standalone: totals.standalone,
                })
              : undefined
          }
          icon={<IconServer size={18} />}
          tone={totals && totals.online < totals.connections ? 'warning' : 'accent'}
          loading={fleet.isLoading}
        />
      </div>

      {/* 面板自身的版本与更新（检查新版本 / 一键更新 / 手工命令） */}
      <PanelUpdateCard />

      <div className="set-info-grid mt-16">
        <div className="set-info-tile">
          <span className="set-info-label">{t('settings.systemInfoUser')}</span>
          <span className="set-info-value">
            {currentUsername ?? t('settings.systemUnknown')}
            {currentRole ? (
              <span className="fs-xs text-muted mono"> · {currentRole}</span>
            ) : null}
          </span>
        </div>

        <div className="set-info-tile">
          <span className="set-info-label">{t('settings.systemInfoPanelUrl')}</span>
          <span className="set-info-value mono fs-sm">{window.location.origin}</span>
        </div>

        <div className="set-info-tile">
          <span className="set-info-label">{t('settings.systemInfoApiBase')}</span>
          <span className="set-info-value mono fs-sm">/api</span>
        </div>

        <div className="set-info-tile">
          <span className="set-info-label">{t('settings.systemInfoTimezone')}</span>
          <span className="set-info-value mono fs-sm">
            {Intl.DateTimeFormat().resolvedOptions().timeZone}
          </span>
        </div>

        <div className="set-info-tile">
          <span className="set-info-label">{t('settings.systemInfoWindow')}</span>
          <span className="set-info-value mono fs-sm">
            {window.innerWidth} × {window.innerHeight}
          </span>
        </div>

        <div className="set-info-tile">
          <span className="set-info-label">{t('settings.systemInfoEnv')}</span>
          <span className="set-info-value mono fs-sm">
            {import.meta.env.MODE} ·{' '}
            {import.meta.env.PROD
              ? t('settings.systemProdBuild')
              : t('settings.systemDevMode')}
          </span>
        </div>

        <div className="set-info-tile">
          <span className="set-info-label">{t('settings.systemInfoNow')}</span>
          <span className="set-info-value mono fs-sm">
            {formatDateTime(new Date())}
          </span>
        </div>

        <div className="set-info-tile is-wide">
          <span className="set-info-label">{t('settings.systemInfoBrowser')}</span>
          <span className="set-info-value fs-sm" title={navigator.userAgent}>
            {navigator.userAgent}
          </span>
        </div>
      </div>

      {/* 每套 PVE 连接的明细：合计只回答「一共有多少」，
          哪台在线、哪台启用了 HA 要能逐条看到，否则多连接部署下说不清。 */}
      {totals && (fleet.data?.connections?.length ?? 0) > 0 ? (
        <div className="mt-16">
          <div className="set-form-block-head">
            <span className="set-form-block-icon">
              <IconLayers size={15} />
            </span>
            <span className="set-form-block-title">
              {t('settings.systemFleetDetail')}
            </span>
            <span className="set-form-block-hint">
              {totals.ha_enabled > 0
                ? t('settings.systemHaSummary', {
                    clusters: totals.ha_enabled,
                    resources: totals.ha_resources,
                  })
                : t('settings.systemHaNone')}
            </span>
          </div>
          <div className="set-conn-list">
            {(fleet.data?.connections ?? []).map((row) => (
              <div className="set-conn-row" key={row.id}>
                <Badge variant={row.ok ? 'success' : 'danger'} dot size="sm">
                  {row.ok
                    ? t('settings.systemOnline')
                    : t('settings.systemUnreachableShort')}
                </Badge>
                <span className="set-conn-name">{row.name}</span>
                <span className="mono fs-xs text-muted">{row.host}</span>
                <span className="set-conn-meta">
                  {row.ok ? (
                    <>
                      {row.version ? `PVE ${row.version} · ` : ''}
                      {t('settings.systemNodeCount', { n: row.node_count })} ·
                      {row.cluster_mode === 'cluster'
                        ? row.quorate === false
                          ? ` ${t('settings.systemNoQuorumShort')}`
                          : row.ha_enabled
                            ? ` ${t('settings.systemHaOn')}`
                            : ` ${t('settings.systemHaOff')}`
                        : ` ${t('settings.systemStandaloneShort')}`}
                    </>
                  ) : (
                    row.error || t('settings.systemConnFailed')
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* 节点列表 */}
      {cluster && cluster.nodes.length > 0 ? (
        <div className="mt-16">
          <div className="set-form-block-head">
            <span className="set-form-block-icon">
              <IconServer size={15} />
            </span>
            <span className="set-form-block-title">{t('settings.systemNodesTitle')}</span>
            <span className="set-form-block-hint">
              {t('settings.systemNodesCount', { n: cluster.nodes.length })}
              {totals && totals.connections > 1
                ? t('settings.systemReadingFrom', {
                    name: defaultName || t('settings.systemDefaultConnLabel'),
                  })
                : ''}
            </span>
          </div>

          {/* 多套 PVE 时，「读哪一套」必须能选：这几张卡一次只能读一台，
              默认由后端自动挑（第一条），而那往往不是想看的那台。 */}
          {isAdmin && conns.length > 1 ? (
            <div className="set-default-conn">
              <Select
                label={t('settings.systemDefaultConnLabel')}
                hint={t('settings.systemDefaultConnHint')}
                value={defaultId}
                disabled={switching}
                onChange={(event) => void pickDefault(event.target.value)}
                options={conns.map((item) => ({
                  label: `${item.name || item.host}${
                    item.id === defaultId ? t('settings.systemCurrentSuffix') : ''
                  }`,
                  value: item.id,
                }))}
              />
            </div>
          ) : null}

          <div className="set-node-list">
            {cluster.nodes.map((n) => (
              <ClusterNodeRow
                key={n.name}
                name={n.name}
                online={Boolean(n.online)}
                type={n.type}
                canEdit={isAdmin}
              />
            ))}
          </div>
        </div>
      ) : clusterLoading ? (
        <div className="fs-sm text-muted mt-16">{t('settings.systemLoadingNodes')}</div>
      ) : null}

      {!connected && !healthLoading && health ? (
        <Notice tone="danger" title={t('settings.systemPveDownTitle')}>
          {t('settings.systemPveDownBody')}
        </Notice>
      ) : null}

      <CollapsibleCard
        title={t('settings.systemTipsTitle')}
        icon={<IconInfo size={15} />}
      >
        <div className="desc-list">
          <div className="desc-item">
            <div className="desc-label">{t('settings.systemTipAuth')}</div>
            <div className="desc-value">
              {t('settings.systemTipAuthPre')}
              <span className="mono">HttpOnly + SameSite</span>
              {t('settings.systemTipAuthPost')}
            </div>
          </div>
          <div className="desc-item">
            <div className="desc-label">{t('settings.systemTipCert')}</div>
            <div className="desc-value">
              {t('settings.systemTipCertPre')}
              <span className="mono">verify=False</span>
              {t('settings.systemTipCertPost')}
            </div>
          </div>
          <div className="desc-item">
            <div className="desc-label">{t('settings.systemTipWs')}</div>
            <div className="desc-value">
              {t('settings.systemTipWs1')}
              <span className="mono">/api/ws/</span>
              {t('settings.systemTipWs2')}
              <span className="mono">/api/vms/*/console/*ws</span>
              {t('settings.systemTipWs3')}
              <span className="mono">Upgrade</span>
              {t('settings.systemTipWs4')}
              <span className="mono">Connection</span>
              {t('settings.systemTipWs5')}
            </div>
          </div>
          <div className="desc-item">
            <div className="desc-label">{t('settings.systemTipTimeout')}</div>
            <div className="desc-value">{t('settings.systemTipTimeoutBody')}</div>
          </div>
        </div>
      </CollapsibleCard>
    </Card>
  );
}

/* ---------------------------------------------------------------------------
   集群节点条目：状态 / 地址 / 版本 / 备注
   --------------------------------------------------------------------------- */

function ClusterNodeRow({
  name,
  online,
  type,
  canEdit,
}: {
  name: string;
  online: boolean;
  type?: string;
  canEdit: boolean;
}) {
  const t = useT();
  const { version, address } = useNodeMeta(name, online);
  const bits = [version ? `PVE ${version}` : '', address, type]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className={`set-node-item ${online ? 'is-online' : 'is-offline'}`}>
      <div className="set-node-main">
        <span className="set-node-icon">
          <IconServer size={15} />
        </span>
        <div className="set-node-text">
          <span className="set-node-name">{name}</span>
          <span className="fs-xs text-muted mono">{bits || '—'}</span>
        </div>
        <Badge variant={online ? 'success' : 'danger'} dot pulse={online} size="sm">
          {online ? t('settings.systemOnline') : t('settings.systemOffline')}
        </Badge>
      </div>
      <div className="set-node-note">
        <NodeNoteField node={name} canEdit={canEdit} />
      </div>
    </div>
  );
}
