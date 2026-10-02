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
import {
  ALWAYS_OPEN_PATHS,
  FOOTER_NAV_ITEMS,
  NAV_SECTIONS,
  isPathDisabled,
} from '../components/Sidebar';
import { DEFAULT_UI_PREFS } from '../hooks/useUiPrefs';
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
   刷新间隔选项
   --------------------------------------------------------------------------- */

const REFRESH_OPTIONS = [
  { label: '5 秒（实时性优先）', value: '5000' },
  { label: '10 秒（推荐）', value: '10000' },
  { label: '30 秒（平衡）', value: '30000' },
  { label: '60 秒（低负载）', value: '60000' },
  { label: '不自动刷新', value: '0' },
];

const PAGE_SIZE_OPTIONS = [
  { label: '10 条 / 页', value: '10' },
  { label: '20 条 / 页', value: '20' },
  { label: '50 条 / 页', value: '50' },
  { label: '100 条 / 页', value: '100' },
];

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
  /** 所属分组：面板偏好 / 服务端配置 / 运行信息 */
  group: string;
  /** 导航项与卡片标题共用的名字，两边必须一致，否则“点了没跳对地方” */
  label: string;
  /** 导航项的 title：一句话说明这一段改的是什么 */
  desc: string;
  icon: ReactNode;
  /** 需要 settings.manage；没有这个权限的用户看不到这一项 */
  adminOnly?: boolean;
  render: () => ReactNode;
}

/** 分组标题右侧的作用范围说明 —— 这一栏是「改的东西作用在哪」的唯一答案 */
const GROUP_DESC: Record<string, string> = {
  面板偏好: '只影响当前浏览器，与新建虚拟机时预填的默认值',
  服务端配置: '写进服务端，对所有用户生效（需要 settings.manage 权限）',
  运行信息: '只读，看面板自己跑得怎么样',
};

/** 分区卡片的 DOM id 前缀：吸顶导航的跳转与高亮都按 `前缀 + 分区 id` 找元素 */
const SECTION_ID_PREFIX = 'section-';

export function Settings() {
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

  const sections: SettingsSection[] = [
    {
      id: 'panel',
      group: '面板偏好',
      /* 名字取卡片标题本身：导航项与卡片标题不一致时，「点了导航却找不到
         对应卡片」是必然的事 */
      label: '面板设置',
      desc: '刷新频率、每页条数、时区 —— 只影响当前这台浏览器',
      icon: <IconMonitor size={16} />,
      render: () => <PanelSection />,
    },
    {
      id: 'vm-defaults',
      group: '面板偏好',
      label: '创建默认值',
      desc: '新建虚拟机时表单里预填的那套参数，对所有用户生效',
      icon: <IconVm size={16} />,
      adminOnly: true,
      render: () => <VMCreateDefaultsSection />,
    },
    {
      id: 'specs',
      group: '服务端配置',
      label: '资源规格',
      /* 与卡片标题一致：导航项与卡片标题不一样时，用户点了会以为走错了地方 */
      desc: '下单页可选套餐（几核 / 内存 / 磁盘），用户不必自己算资源',
      icon: <IconBox size={16} />,
      adminOnly: true,
      render: () => <ResourceSpecsPanel />,
    },
    {
      id: 'sidebar',
      group: '服务端配置',
      label: '导航栏功能开关',
      desc: '导航栏里每一个入口的开关，关掉的项直接输 URL 也进不去',
      icon: <IconMenu size={16} />,
      adminOnly: true,
      render: () => <SidebarNavSection />,
    },
    {
      id: 'site',
      group: '服务端配置',
      label: '站点信息',
      desc: '面板名称、副标题、版权、备案号、Logo 与登录页背景',
      icon: <IconLayers size={16} />,
      adminOnly: true,
      render: () => <SiteInfoSection />,
    },
    {
      id: 'captcha',
      group: '服务端配置',
      label: '登录验证',
      desc: '登录时要不要过一道人机验证，以及用图形码还是拖动滑块',
      icon: <IconShield size={16} />,
      adminOnly: true,
      render: () => <LoginCaptchaSection />,
    },
    {
      id: 'panel-url',
      group: '服务端配置',
      label: '面板全局地址',
      desc: '邮件与飞书回调里拼链接用的外部域名',
      icon: <IconLink size={16} />,
      adminOnly: true,
      render: () => <PanelUrlSection />,
    },
    {
      id: 'faq',
      group: '服务端配置',
      label: '常见问题',
      desc: '产品官网「常见问题」区块的内容',
      icon: <IconInfo size={16} />,
      adminOnly: true,
      render: () => <FaqSection />,
    },
    {
      id: 'mail',
      group: '服务端配置',
      label: '邮件通知',
      desc: '告警与通知走哪个 SMTP，发件人是谁',
      icon: <IconBell size={16} />,
      adminOnly: true,
      render: () => <EmailSection />,
    },
    {
      id: 'system',
      group: '运行信息',
      label: '系统信息',
      desc: '面板自身与各套 PVE 的运行状态，只读',
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
  ].filter((item) => !item.adminOnly || canManage);

  const firstId = sections[0]?.id ?? '';
  const wanted = searchParams.get('tab') ?? '';

  /* 导航按顺序分组：同一个 group 的项连续出现，分组标题只在第一项前画一次 */
  const groups: Array<{ name: string; items: SettingsSection[] }> = [];
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
          设置
        </>
      }
      subtitle="面板偏好与系统运行信息"
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
          刷新
        </Button>
      }
    >
      {/* Proxmox 连接已整体移到「节点 → 连接配置」子页面，这里不再出现任何入口：
          设置页管的是「面板自己的偏好」，连接管的是「有哪些 PVE 主机可管」。 */}
      <nav className="page-index" aria-label="设置分区">
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
            <h2 className="page-section-title">{group.name}</h2>
            <p className="page-section-desc">{GROUP_DESC[group.name]}</p>
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
  const toast = useToast();
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
    toast.success('面板设置已保存', '刷新页面后依然生效');
    /* 通知其他页面重新读取刷新间隔 */
    window.dispatchEvent(new CustomEvent('ProxCenter:settings-changed'));
  };

  const reset = () => {
    setSettings(defaultSettings);
    saveSettings(defaultSettings);
    setSaved(defaultSettings);
    toast.info('已恢复默认设置');
    window.dispatchEvent(new CustomEvent('ProxCenter:settings-changed'));
  };

  const timezoneGuess = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <Card>
      <CardHeader
        title="面板设置"
        subtitle="这些偏好仅保存在当前浏览器，不会同步到服务端"
        icon={<IconSettings size={17} />}
      />

      <div className="dyn-list mt-16">
        <div className="set-form-block-head">
          <span className="set-form-block-icon">
            <IconActivity size={15} />
          </span>
          <span className="set-form-block-title">数据与展示</span>
          <span className="set-form-block-hint">轮询频率与长列表分页</span>
        </div>

        {/* 三个字段并排。原先「数据与展示」占一行、时区又单起一行，末尾那行
            只有一只输入框，右半边整片空着 —— 时区本来就和刷新频率同级。 */}
        <div className="set-grid set-grid--3">
          <Field
            label="数据刷新间隔"
            hint="列表与监控图表的自动轮询频率。间隔越短对集群压力越大。"
          >
            <Select
              value={String(settings.refreshInterval)}
              onChange={(e) => patch('refreshInterval', Number(e.target.value))}
              options={REFRESH_OPTIONS}
            />
          </Field>

          <Field label="列表每页条数" hint="虚拟机、备份、审计日志等长列表的分页大小">
            <Select
              value={String(settings.pageSize)}
              onChange={(e) => patch('pageSize', Number(e.target.value))}
              options={PAGE_SIZE_OPTIONS}
            />
          </Field>

          <Field
            label="时区"
            hint={`浏览器检测到的时区：${timezoneGuess}。仅影响本地展示，不影响后端存储。`}
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

      <Notice tone="info" title="关于浏览器本地设置的说明">
        这些设置保存在 <span className="mono">localStorage.pve_panel_settings</span>，
        换浏览器或清空站点数据后会恢复默认值。如需跨设备统一，需要后端提供用户偏好接口。
      </Notice>

      <div className="set-action-bar">
        <Button
          variant="primary"
          icon={<IconSave size={15} />}
          onClick={save}
          disabled={!dirty}
        >
          保存设置
        </Button>
        <Button variant="secondary" onClick={reset}>
          恢复默认
        </Button>
        <span className="set-action-spacer" />
        {dirty ? (
          <span className="fs-sm text-warning">有未保存的修改</span>
        ) : null}
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------------------
   区块 3：虚拟机创建默认值（服务端设置，作用于所有用户）
   --------------------------------------------------------------------------- */

function VMCreateDefaultsSection() {
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
      toast.error('虚拟机额度必须是非负整数', '留空表示不限制');
      return;
    }
    if (lxcText && !/^\d+$/.test(lxcText)) {
      toast.error('容器额度必须是非负整数', '留空表示不限制');
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
        '已保存',
        saved.dns ? `默认 DNS：${saved.dns}` : '默认 DNS：留空（不干预）',
      );
      void queryClient.invalidateQueries({ queryKey: ['config', 'vm-defaults'] });
      void queryClient.invalidateQueries({ queryKey: ['config', 'vm-quota'] });
      void queryClient.invalidateQueries({ queryKey: ['config', 'lxc-quota'] });
    } catch (err) {
      toast.error('保存失败', errorMessage(err));
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
        title="创建默认值"
        subtitle="保存到服务端，作用于所有用户的创建 / 克隆操作"
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
            保存
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
            <span className="set-form-block-title">Cloud-Init 默认 DNS</span>
            <span className="set-form-block-hint">留空则不干预</span>
          </div>

          <Field
            label="默认 DNS"
            hint="创建 / 克隆虚拟机时，未单独填写 DNS 的一律写入这里配置的地址。模板机大多走 DHCP，客户机容易被路由器 RA 下发的 DNS 带跑；若那组 DNS 不可达（局域网“假 IPv6”很常见），虚拟机就会完全解析不了域名、表现为连不上外网 —— 填一个可用的 IPv4 DNS 即可避免。多个地址用空格分隔。"
          >
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
            <span className="set-form-block-title">可下发虚拟机数量</span>
            <span className="set-form-block-hint">留空则不限制</span>
          </div>

          <Field
            label="虚拟机额度"
            hint="这台面板最多允许多少台虚拟机（跨所有 PVE 连接统计，含模板）。填 0 时普通用户完全无法创建虚拟机；留空表示不限制。管理员不受此限制 —— 到达上限后需要有人能清理与扩容。"
          >
            <Input
              value={quotaText}
              onChange={(e) => setQuotaText(e.target.value)}
              placeholder="留空 = 不限制"
              className="mono"
              inputMode="numeric"
              autoComplete="off"
              disabled={!canManage}
            />
          </Field>

          {quotaQuery.data ? (
            <div className="set-readout">
              <span>
                当前已用 <b>{quotaUsed}</b> 台
              </span>
              {quotaRemaining != null ? (
                <span>
                  · 还可下发 <b>{quotaRemaining}</b> 台
                </span>
              ) : null}
              {quotaQuery.data.count_error ? (
                <span className="set-readout-warn">
                  · 部分 PVE 连接读取失败，实际台数可能更多（
                  {quotaQuery.data.count_error}）
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
            <span className="set-form-block-title">可下发容器数量</span>
            <span className="set-form-block-hint">留空则不限制</span>
          </div>

          <Field
            label="容器额度"
            hint="最多允许多少个容器（跨所有 PVE 连接统计，含容器模板）。与左边的虚拟机额度各记一份、互不占用：填 0 只挡容器，不影响建虚拟机。管理员同样不受限。"
          >
            <Input
              value={lxcQuotaText}
              onChange={(e) => setLxcQuotaText(e.target.value)}
              placeholder="留空 = 不限制"
              className="mono"
              inputMode="numeric"
              autoComplete="off"
              disabled={!canManage}
            />
          </Field>

          {lxcQuotaQuery.data ? (
            <div className="set-readout">
              <span>
                当前已用 <b>{lxcUsed}</b> 个
              </span>
              {lxcRemaining != null ? (
                <span>
                  · 还可下发 <b>{lxcRemaining}</b> 个
                </span>
              ) : null}
              {lxcQuotaQuery.data.count_error ? (
                <span className="set-readout-warn">
                  · 部分 PVE 连接读取失败，实际数量可能更多（
                  {lxcQuotaQuery.data.count_error}）
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {!canManage ? (
        <div className="mt-16">
          <Notice tone="info" title="只读">
            当前账号对该设置只有查看权限，修改需要管理员（settings.manage 权限）。
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
      toast.success('站点信息已保存', `当前站点名称：${saved.name}`);
      void queryClient.invalidateQueries({ queryKey: ['config', 'site'] });
    } catch (err) {
      toast.error('保存失败', errorMessage(err));
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
      toast.success('Logo 已更新', '侧边栏、登录页与产品官网已同步');
      void queryClient.invalidateQueries({ queryKey: ['config', 'site'] });
    } catch (err) {
      toast.error('上传失败', errorMessage(err));
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
      toast.success('已移除自定义 Logo', '界面已恢复内置图标');
      void queryClient.invalidateQueries({ queryKey: ['config', 'site'] });
    } catch (err) {
      toast.error('移除失败', errorMessage(err));
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
      toast.success('登录背景已更新', '登录 / 注册 / 找回密码页已同步');
      void queryClient.invalidateQueries({ queryKey: ['config', 'site'] });
    } catch (err) {
      toast.error('上传失败', errorMessage(err));
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
      toast.success('已移除自定义背景', '登录页已恢复内置插画');
      void queryClient.invalidateQueries({ queryKey: ['config', 'site'] });
    } catch (err) {
      toast.error('移除失败', errorMessage(err));
    } finally {
      setBgBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="站点信息"
        subtitle="自定义面板名称与版权文案，保存到服务端，对所有用户生效"
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
              恢复默认
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<IconSave size={14} />}
              loading={busy}
              disabled={!canManage || query.isLoading}
              onClick={() => void save()}
            >
              保存
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
          <span className="set-form-block-title">品牌与文案</span>
          <span className="set-form-block-hint">留空则使用默认值</span>
        </div>

        <div className="dyn-row">
          <Field
            label="站点 Logo"
            hint="支持 PNG / JPG / WebP / GIF / SVG / ICO，建议使用方形图，512 KB 以内。显示在侧边栏、登录页与产品官网，并同时作为浏览器标签页图标；选好文件立即生效，无需点保存。"
          >
            <div className="brand-upload">
              <span className="brand-upload-preview">
                {form.logo_url ? (
                  <img src={form.logo_url} alt="当前 Logo 预览" />
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
                  {form.logo_url ? '更换图片' : '上传图片'}
                </Button>
                {form.logo_url ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<IconTrash size={14} />}
                    disabled={!canManage || logoBusy}
                    onClick={() => void resetLogo()}
                  >
                    恢复内置
                  </Button>
                ) : null}
              </div>
            </div>
          </Field>
        </div>

        <div className="dyn-row">
          <Field
            label="登录页背景"
            hint="显示在登录 / 注册 / 找回密码页的整屏背景上。支持 PNG / JPG / WebP / GIF，建议横图（如 1920×1080），4 MB 以内；选好文件立即生效，无需点保存。"
          >
            <div className="brand-upload">
              <span className="brand-upload-preview brand-upload-preview--wide">
                {form.login_bg_url ? (
                  <img src={form.login_bg_url} alt="当前登录页背景预览" />
                ) : (
                  <span className="fs-xs text-muted">内置插画</span>
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
                  {form.login_bg_url ? '更换图片' : '上传图片'}
                </Button>
                {form.login_bg_url ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<IconTrash size={14} />}
                    disabled={!canManage || bgBusy}
                    onClick={() => void resetLoginBg()}
                  >
                    恢复内置
                  </Button>
                ) : null}
              </div>
            </div>
          </Field>
        </div>

        <div className="dyn-row">
          <Field
            label="站点名称"
            hint="显示在侧边栏、登录页、产品官网，以及浏览器标签页标题上。留空则恢复内置的默认名称。"
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
          <Field label="副标题" hint="显示在侧边栏品牌名称下方。留空则恢复默认。">
            <Input
              value={form.subtitle}
              onChange={(e) => patch('subtitle', e.target.value)}
              placeholder={DEFAULT_SITE_INFO.subtitle}
              maxLength={40}
              autoComplete="off"
              disabled={!canManage}
            />
          </Field>
        </div>

        <div className="dyn-row">
          <Field label="版权信息" hint="显示在产品官网页脚。留空则恢复默认。">
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
            label="备案号"
            hint="显示在产品官网页脚，例如「京ICP备2024000000号-1」。留空则不展示。"
          >
            <Input
              value={form.icp}
              onChange={(e) => patch('icp', e.target.value)}
              placeholder="京ICP备2024000000号-1"
              maxLength={64}
              autoComplete="off"
              disabled={!canManage}
            />
          </Field>
        </div>

        <div className="dyn-row">
          <Field
            label="友情链接"
            className="is-wide"
            hint="显示在产品官网页脚。最多 12 条；地址需以 http:// 或 https:// 开头，也支持 / 开头的站内路径。"
          >
            <div className="link-editor">
              {form.links.length === 0 ? (
                <p className="link-editor-empty">还没有添加友情链接</p>
              ) : (
                form.links.map((link, index) => (
                  <div className="link-editor-row" key={index}>
                    <Input
                      value={link.name}
                      onChange={(e) => patchLink(index, 'name', e.target.value)}
                      placeholder="站点名称"
                      maxLength={24}
                      autoComplete="off"
                      disabled={!canManage}
                      aria-label={`第 ${index + 1} 条友链的名称`}
                    />
                    <Input
                      value={link.url}
                      onChange={(e) => patchLink(index, 'url', e.target.value)}
                      placeholder="https://example.com"
                      maxLength={300}
                      autoComplete="off"
                      disabled={!canManage}
                      aria-label={`第 ${index + 1} 条友链的地址`}
                    />
                    <IconButton
                      label={`删除第 ${index + 1} 条友情链接`}
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
                  添加链接
                </Button>
                <span className="fs-xs text-muted">
                  {form.links.length} / 12；名称或地址为空的条目在保存时会被丢弃
                </span>
              </div>
            </div>
          </Field>
        </div>

        {!canManage ? (
          <Notice tone="info" title="只读">
            当前账号对该设置只有查看权限，修改需要管理员（settings.manage 权限）。
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
      toast.error('保存失败', errorMessage(err));
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
      next ? `已开启「${label}」` : `已关闭「${label}」`,
      next
        ? '该入口在所有用户的控制台里恢复显示'
        : '该入口从侧边栏、顶栏菜单与全局搜索里一起消失，直接输地址也会被弹回',
    );

  /* 分组与顺序直接取侧边栏那一份（末尾补上底部账号区的项）：设置页看到的
     分组必须和用户在侧边栏里看到的一致，另维护一份清单迟早会对不上。 */
  const groups = [
    ...NAV_SECTIONS.map((section) => ({
      title: section.title,
      items: section.items,
    })),
    { title: '账号', items: FOOTER_NAV_ITEMS },
  ];

  const closedCount = prefs.nav_disabled.length;

  return (
    <Card>
      <CardHeader
        title="导航栏功能开关"
        subtitle="导航栏里每一个入口的开关；关掉的项对所有用户立即生效"
        icon={<IconMenu size={17} />}
        actions={
          busy ? (
            <Badge variant="info" size="sm">
              保存中…
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
          <div className="dyn-list mt-16" key={group.title}>
            <div className="set-form-block-head">
              <span className="set-form-block-icon">
                <IconMenu size={15} />
              </span>
              <span className="set-form-block-title">{group.title}</span>
              <span className="set-form-block-hint">
                {closed > 0 ? `${closed} 项已关闭` : '全部开启'}
              </span>
            </div>

            <div className="set-grid set-grid--3">
              {group.items.map((item) => {
                /* 恢复入口不能关：关掉之后界面上再没有地方能把这些开关打开 */
                const locked = LOCKED_NAV_PATHS.has(item.to);
                return (
                  <Switch
                    key={item.to}
                    checked={!isPathDisabled(item.to, prefs.nav_disabled)}
                    onChange={(next) => toggleItem(item.to, item.label, next)}
                    disabled={!canManage || busy || locked}
                    label={item.label}
                    hint={locked ? '恢复入口，始终保留' : item.to}
                    ariaLabel={`显示「${item.label}」入口`}
                  />
                );
              })}
            </div>
          </div>
        );
      })}

      <Notice tone="info" title="关掉的入口会被彻底隐藏">
        从导航栏、顶栏头像菜单、Ctrl / ⌘ + K 全局搜索里一起消失，直接输地址也会被弹回
        第一个还开着的页面。它关的是入口，不是授权 —— 对应接口的权限仍由角色决定。
      </Notice>

      {closedCount > 0 ? (
        <div className="set-action-bar">
          <Button
            variant="secondary"
            onClick={() =>
              void save(
                { ...prefs, nav_disabled: [] },
                '已恢复全部入口',
                '所有侧边栏入口在所有用户的控制台里重新显示',
              )
            }
            disabled={!canManage || busy}
          >
            恢复全部入口
          </Button>
          <span className="set-action-spacer" />
          <span className="fs-sm text-warning">
            {closedCount} 个入口已关闭
          </span>
        </div>
      ) : null}

      {!canManage ? (
        <div className="mt-16">
          <Notice tone="info" title="只读">
            当前账号对该设置只有查看权限，修改需要管理员（settings.manage 权限）。
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
const CAPTCHA_OPTIONS: Array<{ label: string; value: LoginCaptchaMode }> = [
  { label: '关闭', value: 'off' },
  { label: '拖动滑块（默认）', value: 'slider' },
  { label: '图形验证码', value: 'image' },
];

const CAPTCHA_HINT: Record<LoginCaptchaMode, string> = {
  off: '登录页不再要求任何验证，仅适合内网或纯人用的环境',
  image: '登录页显示四位图形验证码，点图片可更换（用系统字体绘制，未装字体时字体为内置）',
  slider: '登录页显示拖动滑块拼图，拖到位再点「登录」；未配置过时的默认方式',
};

function LoginCaptchaSection() {
  const toast = useToast();
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
      toast.success('登录验证方式已更新', CAPTCHA_HINT[saved.mode]);
    } catch (err) {
      // 失败时不动 mode：SegmentedControl 是受控的，会自己弹回原值
      toast.error('保存失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="登录验证"
        subtitle="登录页用哪种验证方式，保存后立即对所有人生效"
        icon={<IconShield size={17} />}
        actions={
          busy ? (
            <Badge variant="info" size="sm">
              保存中…
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
            <span className="set-form-block-title">验证方式</span>
            <span className="set-form-block-hint">点一下即保存，无需再按别的按钮</span>
          </div>

          <Field
            label="登录验证"
            hint="图形验证码与滑块都要求用户先完成一次人机验证，再校验账号密码 —— 脚本因此摸不到「密码对不对」这个信号。关闭后只剩「连续失败锁定」，公网可达的面板不建议关闭。"
          >
            <SegmentedControl<LoginCaptchaMode>
              value={mode}
              onChange={(next) => void save(next)}
              ariaLabel="登录验证方式"
              options={CAPTCHA_OPTIONS}
            />
          </Field>

          {mode === 'off' ? (
            <Notice tone="warning" title="验证码已关闭">
              登录接口目前只靠「失败次数锁定」挡爆破。面板一旦能从公网访问，
              建议改回图形验证码或滑块 —— 这一层正是让脚本猜不动的东西。
            </Notice>
          ) : null}
        </div>

        <div className="set-col">
          <div className="set-form-block-head">
            <span className="set-form-block-icon">
              <IconInfo size={15} />
            </span>
            <span className="set-form-block-title">三种方式的区别</span>
            <span className="set-form-block-hint">高亮的是当前生效的一条</span>
          </div>

          <ul className="set-option-list">
            {CAPTCHA_OPTIONS.map((option) => (
              <li
                key={option.value}
                className={`set-option${option.value === mode ? ' is-active' : ''}`}
              >
                <span className="set-option-mark" aria-hidden="true">
                  <IconCheck size={13} />
                </span>
                <span className="set-option-text">
                  <span className="set-option-name">{option.label}</span>
                  <span>{CAPTCHA_HINT[option.value]}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {!canManage ? (
        <div className="mt-16">
          <Notice tone="info" title="只读">
            当前账号对该设置只有查看权限，修改需要管理员（settings.manage 权限）。
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
        '面板全局地址已保存',
        saved.url
          ? `邮件里的链接将统一使用 ${saved.url}`
          : '已清除：邮件链接将回落到本次请求的 Host',
      );
      void queryClient.invalidateQueries({ queryKey: ['config', 'panel-url'] });
    } catch (err) {
      toast.error('保存失败', errorMessage(err));
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
        title="面板全局地址"
        subtitle="邮件与外部系统里指向本面板的链接统一使用这个对外域名"
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
            保存
          </Button>
        }
      />

      <div className="set-cols mt-16">
        <div className="set-col">
          <div className="set-form-block-head">
            <span className="set-form-block-icon">
              <IconLink size={15} />
            </span>
            <span className="set-form-block-title">对外访问地址</span>
            <span className="set-form-block-hint">
              例如 https://prox.yjscloud.com（协议可省略，默认 https）
            </span>
          </div>

          <Field
            label="面板地址"
            hint="忘记密码的重置链接、注册审批结果、飞书机器人回调地址都用它拼接。面板挂在反向代理 / frp 后面时，请求里的 Host 常是 localhost:8080 —— 收件人打不开那样的链接，所以这里要填外部真正可达的域名。留空 = 回落到请求 Host（仅适合内网直连）。"
          >
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
            <span className="set-form-block-title">生效后的链接</span>
            <span className="set-form-block-hint">
              {url.trim() ? '按上面填的地址拼接' : '未填写，回落到请求 Host'}
            </span>
          </div>

          <div className="set-preview">
            <div className="set-preview-row">
              <span className="set-preview-label">重置密码（邮件正文里的按钮）</span>
              <span className="set-preview-url">{base}/reset-password?token=…</span>
            </div>
            <div className="set-preview-row">
              <span className="set-preview-label">飞书机器人事件回调地址</span>
              <span className="set-preview-url">{base}/api/feishu/event</span>
            </div>
            <div className="set-preview-row">
              <span className="set-preview-label">
                当前请求 Host（留空时就用它）
              </span>
              <span className="set-preview-url">{window.location.origin}</span>
            </div>
          </div>
        </div>
      </div>

      {!canManage ? (
        <div className="mt-16">
          <Notice tone="info" title="只读">
            当前账号对该设置只有查看权限，修改需要管理员（settings.manage 权限）。
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
      toast.success('常见问题已保存', `当前 ${saved.length} 条`);
      void queryClient.invalidateQueries({ queryKey: ['config', 'faq'] });
    } catch (err) {
      toast.error('保存失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      const restored = await faqApi.reset();
      setItems(restored);
      toast.success('已恢复默认问题', `当前 ${restored.length} 条`);
      void queryClient.invalidateQueries({ queryKey: ['config', 'faq'] });
    } catch (err) {
      toast.error('恢复失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="常见问题"
        subtitle="产品官网「常见问题」区块的内容，保存到服务端，对所有访问者生效"
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
              恢复默认
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<IconSave size={14} />}
              loading={busy}
              disabled={!canManage || query.isLoading}
              onClick={() => void save()}
            >
              保存
            </Button>
          </>
        }
      />

      <div className="dyn-list mt-16">
        <div className="set-form-block-head">
          <span className="set-form-block-icon">
            <IconSettings size={15} />
          </span>
          <span className="set-form-block-title">问题列表</span>
          <span className="set-form-block-hint">
            列表留空即关闭官网上的该区块
          </span>
        </div>

        {items.length === 0 ? (
          <p className="link-editor-empty">
            列表为空，产品官网将不再展示「常见问题」区块，导航入口也会一并隐藏。
          </p>
        ) : (
          items.map((item, index) => (
            <div className="faq-editor-item" key={index}>
              <div className="faq-editor-head">
                <span className="faq-editor-index mono">#{index + 1}</span>
                <div className="faq-editor-tools">
                  <IconButton
                    label={`上移第 ${index + 1} 条`}
                    disabled={!canManage || index === 0}
                    onClick={() => moveItem(index, -1)}
                  >
                    <IconChevronUp size={14} />
                  </IconButton>
                  <IconButton
                    label={`下移第 ${index + 1} 条`}
                    disabled={!canManage || index === items.length - 1}
                    onClick={() => moveItem(index, 1)}
                  >
                    <IconChevronDown size={14} />
                  </IconButton>
                  <IconButton
                    label={`删除第 ${index + 1} 条`}
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
                placeholder="问题，例如：需要把 Proxmox 暴露到公网吗？"
                maxLength={200}
                autoComplete="off"
                disabled={!canManage}
                aria-label={`第 ${index + 1} 条问题的标题`}
              />
              <Textarea
                value={item.a}
                onChange={(e) => patchItem(index, 'a', e.target.value)}
                placeholder="答案"
                rows={3}
                maxLength={2000}
                disabled={!canManage}
                aria-label={`第 ${index + 1} 条问题的答案`}
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
            添加问题
          </Button>
          <span className="fs-xs text-muted">
            {items.length} / 30；问题或答案为空的条目在保存时会被丢弃
          </span>
        </div>

        {!canManage ? (
          <Notice tone="info" title="只读">
            当前账号对该设置只有查看权限，修改需要管理员（settings.manage 权限）。
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
        '邮件配置已保存',
        saved.configured
          ? 'SMTP 已就绪，可以点「测试发送」验证'
          : '还差服务器地址或发件人，暂时发不出邮件',
      );
      void queryClient.invalidateQueries({ queryKey: ['config', 'mail'] });
    } catch (err) {
      toast.error('保存失败', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const res = await mailApi.test(testTo.trim());
      toast.success('测试邮件已发出', res.detail);
    } catch (err) {
      toast.error('测试发送失败', errorMessage(err));
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
      return '465 端口要用「SSL / TLS」，当前选的是其它方式，会连接超时';
    }
    if (port === 587 && mode === 'ssl') {
      return '587 端口要用「STARTTLS」，选 SSL 会连接超时';
    }
    if (port === 25 && mode === 'ssl') {
      return '25 端口是明文端口，选 SSL 会连接超时';
    }
    return '';
  }, [form.port, form.tls]);



  return (
    <Card>
      <CardHeader
        title="邮件通知"
        subtitle="面板通过这一台 SMTP 服务器发信：注册审批通知、告警邮件都走它"
        icon={<IconBell size={17} />}
        actions={
          <>
            <Badge variant={configured ? 'success' : 'neutral'} dot size="sm">
              {query.isLoading ? '读取中…' : configured ? '已就绪' : '未配置'}
            </Badge>
            <Button
              variant="primary"
              size="sm"
              icon={<IconSave size={14} />}
              loading={busy}
              disabled={!canManage || query.isLoading}
              onClick={() => void save()}
            >
              保存
            </Button>
          </>
        }
      />

      {!canManage ? (
        <div className="mb-16">
          <Notice tone="info" title="只读">
            邮件服务器配置仅管理员可修改。以下内容为当前生效的设置。
          </Notice>
        </div>
      ) : null}

      <div className="flex flex-col gap-16">
        <Switch
          checked={Boolean(form.enabled)}
          onChange={(v) => patch('enabled', v)}
          label="启用邮件通知"
          hint="关闭后注册审批与告警都不再发信（配置会保留）"
          disabled={!canManage}
        />

        <div className="form-grid-2">
          <Field label="SMTP 服务器" required hint="主机名或 IP，例如 smtp.example.com">
            <Input
              value={form.host ?? ''}
              onChange={(e) => patch('host', e.target.value)}
              placeholder="smtp.example.com"
              mono
              disabled={!canManage}
            />
          </Field>
          <Field label="端口" hint="587 用 STARTTLS，465 用 SSL">
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
            label="加密方式"
            error={tlsMismatch || undefined}
            hint="587 配 STARTTLS、465 配 SSL，两者必须对应"
          >
            <Select
              value={form.tls ?? 'starttls'}
              onChange={(e) => patch('tls', e.target.value as MailTlsMode)}
              options={[
                { label: 'STARTTLS（587，推荐）', value: 'starttls' },
                { label: 'SSL / TLS（465）', value: 'ssl' },
                { label: '不加密（内网中继）', value: 'none' },
              ]}
              disabled={!canManage}
            />
          </Field>
          <Field label="SMTP 账号" hint="留空表示匿名投递（内网中继常见）">
            <Input
              value={form.username ?? ''}
              onChange={(e) => patch('username', e.target.value)}
              placeholder="选填"
              autoComplete="off"
              disabled={!canManage}
            />
          </Field>
        </div>

        <Field
          label="SMTP 密码"
          hint={
            passwordSet
              ? '已保存密码，留空表示不修改'
              : '未保存密码；匿名投递可以留空'
          }
        >
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={passwordSet ? '••••••••（留空不修改）' : '选填'}
            autoComplete="new-password"
            disabled={!canManage}
          />
        </Field>

        {passwordSet ? (
          <Switch
            checked={passwordClear}
            onChange={setPasswordClear}
            label="清除已保存的密码"
            hint="勾选后保存即清空密码，适用于改用匿名投递"
            disabled={!canManage}
          />
        ) : null}

        <div className="form-grid-2">
          <Field
            label="发件人地址"
            hint="留空则用 SMTP 账号作为发件人"
          >
            <Input
              value={form.sender ?? ''}
              onChange={(e) => patch('sender', e.target.value)}
              placeholder="noreply@example.com"
              mono
              disabled={!canManage}
            />
          </Field>
          <Field label="发件人名称" hint="收件人看到的显示名">
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
          label="校验服务器 SSL 证书"
          hint="内网自签名证书的邮件服务器需要关掉，否则会连接失败"
          disabled={!canManage}
        />

        <Field
          label="管理员收件人"
          hint="注册与审批通知发给谁。留空则发给所有「启用了账号且填了邮箱」的管理员"
        >
          <Input
            value={form.admin_recipients ?? ''}
            onChange={(e) => patch('admin_recipients', e.target.value)}
            placeholder="ops@example.com, admin@example.com"
            mono
            disabled={!canManage}
          />
        </Field>

        <Notice tone="info" title="告警邮件发给谁？">
          告警邮件的收件人<b>按用户各自配置</b>，不在这里设置：每位用户在
          「告警」页面填写自己的收件地址，留空则发到他的账号邮箱。
          这里只配置发信用的服务器，以及注册 / 审批通知发给哪个管理员邮箱。
        </Notice>

        <div className="set-form-block">
          <div className="set-form-block-head">
            <span className="set-form-block-title">测试发送</span>
            <span className="set-form-block-hint">
              保存之后点一下，确认服务器真的能发出去
            </span>
          </div>
          {/* 按钮紧贴收件人输入框右侧。
              标签 / 说明交给 Field，按钮与输入框一起放进行容器 —— 两者都是
              34px 高，居中对齐天然成立，不用像早先那样塞一个空 label 撑位置。 */}
          <Field label="收件人" hint="留空则发给上面的「管理员收件人」">
            <div className="set-input-action">
              <Input
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                placeholder="留空测试管理员收件人"
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
                发送测试邮件
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
        '已切换默认读取的 PVE',
        `「集群节点状态」与健康探活改读 ${picked?.name || id}，其余连接不受影响`,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['connections'] }),
        queryClient.invalidateQueries({ queryKey: ['cluster', 'status'] }),
        queryClient.invalidateQueries({ queryKey: ['cluster', 'fleet-status'] }),
        queryClient.invalidateQueries({ queryKey: ['health'] }),
      ]);
      onRetryHealth();
    } catch (err) {
      toast.error('切换失败', errorMessage(err));
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
          title="系统信息"
          subtitle="后端健康检查"
          icon={<IconActivity size={17} />}
        />
        <ErrorState
          notImplemented
          title="健康检查接口尚未实现"
          message="后端 /health 返回未实现。该接口应无需认证即可访问，用于探活与前端启动检测。"
          onRetry={onRetryHealth}
        />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="系统信息"
        subtitle={`最近检查：${formatDateTime(lastChecked)}`}
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
                ? '检测中'
                : connected
                  ? '集群已连接'
                  : '集群不可达'}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              icon={<IconRefresh size={14} />}
              onClick={onRetryHealth}
              loading={healthLoading}
            >
              重新检测
            </Button>
          </>
        }
      />

      <div className="set-kpi-grid mt-16">
        <KpiCard
          label="面板状态"
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
          label="Proxmox 版本"
          value={health?.pve_version || cluster?.version || '—'}
          hint={health?.pve_connected ? '当前已连接' : '未连接'}
          icon={<IconServer size={18} />}
          tone="accent"
          loading={healthLoading || clusterLoading}
        />
        <KpiCard
          label={totals ? 'PVE 节点合计' : '集群节点'}
          value={totals ? totals.nodes : (cluster?.nodes.length ?? '—')}
          hint={
            totals
              ? `${totals.online}/${totals.connections} 条连接在线`
              : cluster
                ? cluster.quorate === true
                  ? '仲裁正常'
                  : cluster.quorate === false
                    ? '仲裁丢失'
                    : '单机节点'
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
          label="PVE 连接"
          value={totals ? totals.connections : '—'}
          hint={
            totals
              ? `${totals.clusters} 个集群 · ${totals.standalone} 台单机`
              : undefined
          }
          icon={<IconServer size={18} />}
          tone={totals && totals.online < totals.connections ? 'warning' : 'accent'}
          loading={fleet.isLoading}
        />
      </div>

      <div className="set-info-grid mt-16">
        <div className="set-info-tile">
          <span className="set-info-label">当前用户</span>
          <span className="set-info-value">
            {currentUsername ?? '未知'}
            {currentRole ? (
              <span className="fs-xs text-muted mono"> · {currentRole}</span>
            ) : null}
          </span>
        </div>

        <div className="set-info-tile">
          <span className="set-info-label">面板地址</span>
          <span className="set-info-value mono fs-sm">{window.location.origin}</span>
        </div>

        <div className="set-info-tile">
          <span className="set-info-label">API 基址</span>
          <span className="set-info-value mono fs-sm">/api</span>
        </div>

        <div className="set-info-tile">
          <span className="set-info-label">时区</span>
          <span className="set-info-value mono fs-sm">
            {Intl.DateTimeFormat().resolvedOptions().timeZone}
          </span>
        </div>

        <div className="set-info-tile">
          <span className="set-info-label">窗口尺寸</span>
          <span className="set-info-value mono fs-sm">
            {window.innerWidth} × {window.innerHeight}
          </span>
        </div>

        <div className="set-info-tile">
          <span className="set-info-label">运行环境</span>
          <span className="set-info-value mono fs-sm">
            {import.meta.env.MODE} · {import.meta.env.PROD ? '生产构建' : '开发模式'}
          </span>
        </div>

        <div className="set-info-tile">
          <span className="set-info-label">当前时间</span>
          <span className="set-info-value mono fs-sm">
            {formatDateTime(new Date())}
          </span>
        </div>

        <div className="set-info-tile is-wide">
          <span className="set-info-label">浏览器</span>
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
            <span className="set-form-block-title">PVE 连接明细</span>
            <span className="set-form-block-hint">
              {totals.ha_enabled > 0
                ? `${totals.ha_enabled} 个集群启用 HA · ${totals.ha_resources} 个 HA 资源`
                : '暂无集群启用 HA'}
            </span>
          </div>
          <div className="set-conn-list">
            {(fleet.data?.connections ?? []).map((row) => (
              <div className="set-conn-row" key={row.id}>
                <Badge variant={row.ok ? 'success' : 'danger'} dot size="sm">
                  {row.ok ? '在线' : '不可达'}
                </Badge>
                <span className="set-conn-name">{row.name}</span>
                <span className="mono fs-xs text-muted">{row.host}</span>
                <span className="set-conn-meta">
                  {row.ok ? (
                    <>
                      {row.version ? `PVE ${row.version} · ` : ''}
                      {row.node_count} 节点 ·
                      {row.cluster_mode === 'cluster'
                        ? row.quorate === false
                          ? ' 仲裁丢失'
                          : row.ha_enabled
                            ? ' HA 已启用'
                            : ' HA 未启用'
                        : ' 单机'}
                    </>
                  ) : (
                    row.error || '连接失败'
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
            <span className="set-form-block-title">集群节点状态</span>
            <span className="set-form-block-hint">
              共 {cluster.nodes.length} 个节点
              {totals && totals.connections > 1
                ? ` · 读的是「${defaultName || '默认连接'}」，其余见上方明细`
                : ''}
            </span>
          </div>

          {/* 多套 PVE 时，「读哪一套」必须能选：这几张卡一次只能读一台，
              默认由后端自动挑（第一条），而那往往不是想看的那台。 */}
          {isAdmin && conns.length > 1 ? (
            <div className="set-default-conn">
              <Select
                label="默认读取的 PVE"
                hint="只影响「集群节点状态」与健康探活这类一次只能读一台的接口；其余连接仍是同级的，页面照常各自读取"
                value={defaultId}
                disabled={switching}
                onChange={(event) => void pickDefault(event.target.value)}
                options={conns.map((item) => ({
                  label: `${item.name || item.host}${item.id === defaultId ? '（当前）' : ''}`,
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
        <div className="fs-sm text-muted mt-16">正在读取集群节点信息…</div>
      ) : null}

      {!connected && !healthLoading && health ? (
        <Notice tone="danger" title="面板无法连接到 Proxmox 集群">
          请检查「Proxmox 连接配置」中的主机、端口与 API Token 是否正确，
          并确认面板服务器到集群管理端口（默认 8006）的网络可达。
          未连接时所有依赖集群的页面都会显示为空或报错。
        </Notice>
      ) : null}

      <CollapsibleCard title="部署与排错提示" icon={<IconInfo size={15} />}>
        <div className="desc-list">
          <div className="desc-item">
            <div className="desc-label">认证方式</div>
            <div className="desc-value">
              面板自身用 JWT 保护：令牌放在{' '}
              <span className="mono">HttpOnly + SameSite</span> Cookie 里
              （JS 读不到，XSS 也偷不走），写操作另有 CSRF 双提交校验；
              后端再用 API Token 访问 Proxmox。两层认证相互独立，
              因此面板账号被盗不会直接泄露 Proxmox Token。
            </div>
          </div>
          <div className="desc-item">
            <div className="desc-label">自签名证书</div>
            <div className="desc-value">
              若 Proxmox 使用自签名证书且关闭了 verify_ssl，
              后端需要在 httpx / requests 调用中显式传入{' '}
              <span className="mono">verify=False</span>，否则会因证书校验失败而报 502。
            </div>
          </div>
          <div className="desc-item">
            <div className="desc-label">WebSocket</div>
            <div className="desc-value">
              任务日志与 VNC 控制台依赖 WebSocket 代理。
              若部署在 Nginx 之后，需要转发{' '}
              <span className="mono">/api/ws/</span> 与{' '}
              <span className="mono">/api/vms/*/console/*ws</span> 路径，
              并设置 <span className="mono">Upgrade</span> 与{' '}
              <span className="mono">Connection</span> 头。
            </div>
          </div>
          <div className="desc-item">
            <div className="desc-label">超时设置</div>
            <div className="desc-value">
              备份、克隆、迁移等长任务会持续数十分钟。后端发起这类请求时应
              使用较长的超时或改用异步任务模式，避免请求被网关截断。
              前端已通过轮询任务状态的方式规避长连接问题。
            </div>
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
          {online ? '在线' : '离线'}
        </Badge>
      </div>
      <div className="set-node-note">
        <NodeNoteField node={name} canEdit={canEdit} />
      </div>
    </div>
  );
}
