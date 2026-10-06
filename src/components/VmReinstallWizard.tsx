/* ==========================================================================
   ProxCenter — 重装系统（用 Cloud-Init 模板重建系统盘）

   为什么不是「删了重建」：重装要保住机器身份 —— VMID、网卡与 MAC、CPU 内存、
   磁盘拓扑都不动，只把系统盘的内容换掉。后端做到的正是这件事：先把模板的系统盘
   复制成一块新盘（此时旧盘原封不动），再一次性把新盘接到原系统盘位上。
   所以这里要用户填的，实际上是「新系统起来之后该是什么样」：主机名、账号、网络。

   两个必须说清的取舍：
   * 整个流水线在一个请求里跑完（复制大磁盘可能几分钟），所以 UI 只能显示
     「进行中」而不能给百分比 —— PVE 的 import-from 任务是黑盒；
   * 删旧盘是既定行为（省一半空间），没有「保留旧盘」的开关 —— 想回滚就再做一次
     重装；留一块旧盘在机器上，只会悄悄吃掉空间；
   * 网络默认**沿用原系统在用的地址**（见下面 netQuery），不默认 DHCP：重装最气人的
     结果不是装失败，而是装完机器换了个 IP，用户按记忆里的地址连不上。
   ========================================================================== */

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { storagesApi, vmMetaApi, vmMetaKey, vmReinstallApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { useToast } from '../hooks/useToast';
import { useT } from '../i18n';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { Field, Input, SegmentedControl, Select, Switch, Textarea } from './ui/Input';
import { Notice } from './ui/EmptyState';
import { IconAlert } from './Icons';
import { formatBytes } from '../utils/format';
import type { VmSummary } from '../api/types';

export interface VmReinstallWizardProps {
  open: boolean;
  vm: VmSummary | null;
  onClose: () => void;
  onDone: () => void;
}

export function VmReinstallWizard({ open, vm, onClose, onDone }: VmReinstallWizardProps) {
  const t = useT();
  const toast = useToast();

  const [templateId, setTemplateId] = useState('');
  const [storage, setStorage] = useState('');
  const [hostname, setHostname] = useState('');
  const [ciUser, setCiUser] = useState('root');
  const [ciPassword, setCiPassword] = useState('');
  const [sshKeys, setSshKeys] = useState('');
  const [ipMode, setIpMode] = useState<'dhcp' | 'static'>('dhcp');
  const [ip, setIp] = useState('');
  const [gateway, setGateway] = useState('');
  const [dns, setDns] = useState('');
  const [startAfter, setStartAfter] = useState(true);
  /* 数据盘默认一起删：重装的语义是「这台机器回到干净状态」。要留数据的用户
     取消勾选即可 —— 所以默认开着，而不是默认关着让人自己去发现。 */
  const [wipeDisks, setWipeDisks] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  /* 网络字段是否已被「沿用原系统」自动填过 / 被用户自己动过。两者任一成立就不再
     自动覆盖：预填是异步到的，用户可能已经在自己填了。 */
  const networkAuto = useRef(false);
  const networkTouched = useRef(false);

  const node = vm?.node ?? '';
  const stopped = (vm?.status ?? '') === 'stopped';

  const templatesQuery = useQuery({
    queryKey: ['reinstall-templates', node],
    queryFn: () => vmReinstallApi.templates(node),
    enabled: open && Boolean(node),
    staleTime: 30_000,
    retry: false,
  });
  const storagesQuery = useQuery({
    queryKey: ['storages', 'list', node],
    queryFn: () => storagesApi.list(node),
    enabled: open && Boolean(node),
    staleTime: 60_000,
    retry: false,
  });
  const metaQuery = useQuery({
    queryKey: ['vm-meta'],
    queryFn: vmMetaApi.list,
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });
  /* 原系统在用的网络配置（后端从 PVE 的 ipconfigN 读回来）—— 重装的默认值来源 */
  const netQuery = useQuery({
    queryKey: ['reinstall-network', vm?.connection_id, node, vm?.vmid],
    queryFn: () => vmReinstallApi.network(vm?.node ?? '', vm?.vmid ?? 0),
    enabled: open && Boolean(node) && Boolean(vm),
    staleTime: 10_000,
    retry: false,
  });

  const templates = templatesQuery.data?.templates ?? [];
  const targets = (storagesQuery.data ?? []).filter((item) =>
    String(item.content ?? '')
      .split(',')
      .some((c) => c === 'images' || c === 'rootdir'),
  );
  /* 面板侧记录的手动 IP：**只在 PVE 里读不到网络配置时**才拿它兜底 ——
     它是人手填的，可能带掩码也可能不带，不如 ipconfigN 可靠。 */
  const metaIp = vm
    ? metaQuery.data?.items?.[vmMetaKey(vm.connection_id, vm.node, vm.vmid)]?.ip ?? ''
    : '';

  /* 打开时重置成「一次干净的重装」 */
  useEffect(() => {
    if (!open || !vm) return;
    setHostname(vm.name || '');
    setCiPassword('');
    setSshKeys('');
    setIpMode('dhcp');
    setIp('');
    setGateway('');
    setDns('');
    setStartAfter(true);
    setWipeDisks(true);
    setBusy(false);
    setConfirmOpen(false);
    networkAuto.current = false;
    networkTouched.current = false;
  }, [open, vm?.node, vm?.vmid]);

  /* 数据到了以后补默认选项（用户已经改过就不覆盖） */
  useEffect(() => {
    if (!open) return;
    setTemplateId((prev) => prev || (templates[0] ? String(templates[0].vmid) : ''));
    setStorage((prev) => prev || (targets[0]?.storage ?? ''));
  }, [open, templates, targets]);

  /* 默认「沿用原系统在用的地址」。
     重装最气人的结果不是装失败，而是装完机器换了个 IP —— 用户按记忆里的地址连不上，
     进控制台一看是 DHCP 新拿的。地址写在 PVE 的 ipconfigN 里，机器关着也读得到，
     所以这台机器关机（重装的必要条件）丝毫不影响把它填回来。 */
  useEffect(() => {
    if (!open || networkAuto.current || networkTouched.current) return;
    if (!netQuery.isSuccess) return;
    /* 拿面板记录兜底之前，要确认「确实没记录」而不是「还没查到」，否则会把用户
       已有的手动 IP 当成没有，直接落到 DHCP。 */
    if (!metaQuery.isSuccess && !metaQuery.isError) return;
    networkAuto.current = true;
    const net = netQuery.data;
    if (net.mode === 'static' && net.ip) {
      setIpMode('static');
      setIp(net.ip);
      setGateway(net.gateway);
      setDns(net.dns);
      return;
    }
    /* 原系统就是 DHCP 的，维持 DHCP；没配过 cloud-init 网络的，退回面板记录 */
    if (net.mode !== 'dhcp' && metaIp) {
      setIpMode('static');
      setIp(metaIp);
    }
  }, [open, netQuery.isSuccess, netQuery.data, metaQuery.isSuccess, metaQuery.isError, metaIp]);

  /* 提示当前这次重装会用什么网络 —— 它随用户切换模式而变，不能只报「原配置是什么」 */
  const netHint = (() => {
    const net = netQuery.data;
    if (!netQuery.isSuccess || !net) return '';
    if (net.mode === 'static') {
      return ipMode === 'static'
        ? t('vmReinstall.netFromConfig', { ip: net.ip })
        : t('vmReinstall.netLeaveStatic', { ip: net.ip });
    }
    if (net.mode === 'dhcp') {
      return ipMode === 'dhcp'
        ? t('vmReinstall.netFromDhcp')
        : t('vmReinstall.netOverDhcp');
    }
    return metaIp ? t('vmReinstall.ipFromMeta', { ip: metaIp }) : '';
  })();

  const selected = templates.find((item) => String(item.vmid) === templateId);
  /* 模板系统盘所在的存储。链接克隆靠 backing file 指向母盘，**必须同存储** ——
     换存储就只能整盘复制。把这件事在选存储时就说明白，别等重装完才发现慢了几分钟。 */
  const templateStorage = selected?.disk ? String(selected.disk).split(':')[0] : '';
  const linked = Boolean(templateStorage) && templateStorage === storage;

  const submit = async () => {
    if (!vm || !selected) return;
    setBusy(true);
    try {
      /* 提交即返回：接口只做「能不能开始」的校验，复制系统盘那几分钟在服务端跑。
         所以这里不再等结果 —— 弹窗直接关掉，成功或失败由 ReinstallWatcher 通知。 */
      await vmReinstallApi.run(vm.node, vm.vmid, {
        template_node: selected.node,
        template_vmid: selected.vmid,
        target_storage: storage,
        hostname: hostname.trim(),
        ci_user: ciUser.trim(),
        ci_password: ciPassword,
        ssh_keys: sshKeys,
        ip_mode: ipMode,
        ip: ipMode === 'static' ? ip.trim() : '',
        gateway: ipMode === 'static' ? gateway.trim() : '',
        dns: dns.trim(),
        start: startAfter,
        wipe_data_disks: wipeDisks,
      });
      setConfirmOpen(false);
      toast.success(t('vmReinstall.queued'), t('vmReinstall.queuedBody', { name: vm.name }));
      onDone();
      onClose();
    } catch (err) {
      setConfirmOpen(false);
      toast.error(t('vmReinstall.failed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const blocked = !stopped || !templates.length || !storage;

  return (
    <>
      <Modal
        open={open}
        onClose={busy ? () => undefined : onClose}
        title={t('vmReinstall.title', { name: vm?.name ?? '' })}
        description={t('vmReinstall.subtitle')}
        size="md"
        closeOnOverlay={!busy}
        hideClose={busy}
        footer={
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              {t('common.close')}
            </Button>
            <Button
              variant="danger"
              icon={<IconAlert size={15} />}
              onClick={() => setConfirmOpen(true)}
              loading={busy}
              disabled={blocked || busy}
            >
              {busy ? t('vmReinstall.running') : t('vmReinstall.start')}
            </Button>
          </>
        }
      >
        <div className="dyn-list">
          {!stopped ? (
            <Notice tone="warning" title={t('vmReinstall.needStoppedTitle')}>
              {t('vmReinstall.needStoppedBody')}
            </Notice>
          ) : null}

          {/* 这是一次不可逆的数据删除，不是「改个配置」：把话摆在最显眼的位置，
              而不是只藏在确认框的小字里 —— 用户往往在填参数时就已经决定了要不要做。 */}
          <Notice tone="danger" title={t('vmReinstall.irreversibleTitle')}>
            {t('vmReinstall.irreversibleBody')}
          </Notice>

          {templatesQuery.isError ? (
            <Notice tone="danger" title={t('vmReinstall.loadFailed')}>
              {errorMessage(templatesQuery.error)}
            </Notice>
          ) : !templates.length && !templatesQuery.isLoading ? (
            <Notice tone="warning" title={t('vmReinstall.noTemplate')}>
              {t('vmReinstall.noTemplateBody')}
            </Notice>
          ) : null}

          <div className="field-row">
            <Field label={t('vmReinstall.template')} hint={t('vmReinstall.templateHint')}>
              <Select
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                options={templates.map((item) => ({
                  label: `${item.name}（${item.ostype || '—'} · ${t('vmReinstall.templateSize', {
                    size: formatBytes(item.size),
                  })}）`,
                  value: String(item.vmid),
                }))}
                disabled={!templates.length}
              />
            </Field>
            <Field
              label={t('vmReinstall.targetStorage')}
              hint={
                templateStorage
                  ? linked
                    ? t('vmReinstall.storageLinkedHint')
                    : t('vmReinstall.storageCopyHint', { storage: templateStorage })
                  : t('vmReinstall.targetStorageHint')
              }
            >
              <Select
                value={storage}
                onChange={(e) => setStorage(e.target.value)}
                options={targets.map((item) => ({
                  label: `${item.storage}（${item.type}）`,
                  value: item.storage,
                }))}
              />
            </Field>
          </div>

          <Field label={t('vmReinstall.hostname')} hint={t('vmReinstall.hostnameHint')}>
            <Input value={hostname} onChange={(e) => setHostname(e.target.value)} mono />
          </Field>

          <div className="section-label">{t('vmReinstall.account')}</div>
          <div className="field-row">
            <Field label={t('vmReinstall.ciUser')}>
              <Input value={ciUser} onChange={(e) => setCiUser(e.target.value)} mono />
            </Field>
            <Field label={t('vmReinstall.ciPassword')}>
              <Input
                type="password"
                value={ciPassword}
                onChange={(e) => setCiPassword(e.target.value)}
                autoComplete="new-password"
              />
            </Field>
          </div>
          <Field label={t('vmReinstall.sshKeys')} hint={t('vmReinstall.sshKeysHint')}>
            <Textarea
              rows={3}
              value={sshKeys}
              onChange={(e) => setSshKeys(e.target.value)}
              placeholder="ssh-ed25519 AAAA… user@host"
              mono
            />
          </Field>

          <div className="section-label">{t('vmReinstall.network')}</div>
          <SegmentedControl<'dhcp' | 'static'>
            value={ipMode}
            onChange={(value) => {
              networkTouched.current = true;
              setIpMode(value);
              /* 切回静态时把地址补上：原配置优先（连掩码一起，拿来就能用），
                 其次才是面板记录。用户自己填过就不动他的。 */
              if (value !== 'static' || ip) return;
              const net = netQuery.data;
              if (net?.mode === 'static' && net.ip) {
                setIp(net.ip);
                if (!gateway) setGateway(net.gateway);
                if (!dns) setDns(net.dns);
              } else if (metaIp) {
                setIp(metaIp);
              }
            }}
            options={[
              { label: t('vmReinstall.ipModeDhcp'), value: 'dhcp' },
              { label: t('vmReinstall.ipModeStatic'), value: 'static' },
            ]}
          />
          {ipMode === 'static' ? (
            <div className="field-row">
              <Field label={t('vmReinstall.ip')} required>
                <Input
                  value={ip}
                  onChange={(e) => {
                    networkTouched.current = true;
                    setIp(e.target.value);
                  }}
                  placeholder="10.0.0.10/24"
                  mono
                />
              </Field>
              <Field label={t('vmReinstall.gateway')}>
                <Input
                  value={gateway}
                  onChange={(e) => {
                    networkTouched.current = true;
                    setGateway(e.target.value);
                  }}
                  placeholder="10.0.0.1"
                  mono
                />
              </Field>
              <Field label={t('vmReinstall.dns')}>
                <Input
                  value={dns}
                  onChange={(e) => {
                    networkTouched.current = true;
                    setDns(e.target.value);
                  }}
                  placeholder="223.5.5.5"
                  mono
                />
              </Field>
            </div>
          ) : null}
          {netHint ? <div className="fs-xs text-muted">{netHint}</div> : null}

          <div className="section-label">{t('vmReinstall.options')}</div>
          <Switch
            checked={wipeDisks}
            onChange={setWipeDisks}
            label={t('vmReinstall.wipeDisks')}
            hint={t('vmReinstall.wipeDisksHint')}
          />
          <Switch
            checked={startAfter}
            onChange={setStartAfter}
            label={t('vmReinstall.startAfter')}
          />

          {/* 说清「点完就可以走」：以前这里是个同步接口，用户被弹窗卡着不敢关 */}
          <div className="fs-xs text-muted">{t('vmReinstall.backgroundHint')}</div>
        </div>
      </Modal>

      {/* 强确认：重装会不可逆地抹掉系统盘，让用户手打机器名再放行 */}
      <ConfirmDialog
        open={confirmOpen}
        danger
        title={t('vmReinstall.confirmTitle')}
        message={t('vmReinstall.confirmMessage', {
          name: vm?.name ?? '',
          template: selected?.name ?? '',
        })}
        requireText={vm?.name ?? ''}
        confirmText={t('vmReinstall.confirmText')}
        loading={busy}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void submit()}
      />
    </>
  );
}
