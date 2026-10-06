/* ==========================================================================
   ProxCenter — 导出虚拟机（VMDK / QCOW2 / RAW / OVA）

   为什么只能导出「已关机」的虚拟机：导出是逐块读磁盘（``pvesm path`` 拿到卷
   的真实路径后 ``qemu-img convert``），机器在跑的时候文件是活的 —— 拿到的镜像
   轻则文件系统需要 fsck，重则根本起不来。所以后端直接拒绝非 stopped 的机器，
   前端把按钮置灰并写清原因，而不是让用户点下去再收一个报错。

   为什么要有「作业」这一层：转换几十 GB 的磁盘要几分钟到几十分钟，不可能挂在
   一个 HTTP 请求里。启动后立刻返回作业 id，前端轮询进度，完成后再走流式下载。
   ========================================================================== */

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { storagesApi, vmTransferApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { useToast } from '../hooks/useToast';
import { useT } from '../i18n';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { Field, Input, Select } from './ui/Input';
import { Badge } from './ui/Badge';
import { Notice } from './ui/EmptyState';
import { ProgressBar } from './ui/ProgressBar';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { IconDownload, IconTrash } from './Icons';
import { formatBytes } from '../utils/format';
import type { ExportJob, VmSummary } from '../api/types';

export interface VmExportDialogProps {
  open: boolean;
  vm: VmSummary | null;
  onClose: () => void;
}

const FORMATS = [
  { value: 'vmdk', labelKey: 'vmExport.fmtVmdk' },
  { value: 'qcow2', labelKey: 'vmExport.fmtQcow2' },
  { value: 'raw', labelKey: 'vmExport.fmtRaw' },
  { value: 'ova', labelKey: 'vmExport.fmtOva' },
] as const;

export function VmExportDialog({ open, vm, onClose }: VmExportDialogProps) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();

  const [format, setFormat] = useState('vmdk');
  const [storage, setStorage] = useState('');
  /* 产物名：留空就用虚拟机名。它同时是文件名、.vmx 里的机器名和压缩包名 */
  const [imageName, setImageName] = useState('');
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<ExportJob | null>(null);
  /* 要删的是哪一份产物：可能是正在显示的那个作业，也可能是历史列表里的一条 */
  const [cleanupTarget, setCleanupTarget] = useState<ExportJob | null>(null);

  const node = vm?.node ?? '';
  const stopped = (vm?.status ?? '') === 'stopped';

  const storagesQuery = useQuery({
    queryKey: ['storages', 'list', node],
    queryFn: () => storagesApi.list(node),
    enabled: open && Boolean(node),
    staleTime: 60_000,
    retry: false,
  });
  /* 产物要落到能在宿主机上直接写文件的位置 —— 只有目录型存储可以 */
  const dirStorages = useMemo(
    () => (storagesQuery.data ?? []).filter((item) => item.type === 'dir'),
    [storagesQuery.data],
  );
  useEffect(() => {
    if (open && !storage && dirStorages.length) setStorage(dirStorages[0].storage);
  }, [open, storage, dirStorages]);

  /* 名称默认取虚拟机名。**必须**单独一个 effect：下面那个接进度的 effect 依赖
     jobsQuery.data，轮询期间会反复重跑，把用户正在输入的名字冲掉。 */
  useEffect(() => {
    if (!open || !vm) return;
    setImageName(vm.name || '');
  }, [open, vm]);

  /* 打开时先看看这台机器有没有正在跑的导出：几十 GB 的转换要跑很久，用户完全
     可能关掉对话框去做别的事 —— 再打开时必须能接上进度，而不是显示成「没导过」。
     没有进行中的作业时才清空状态（同一个对话框换个目标也一样）。 */
  const jobsQuery = useQuery({
    queryKey: ['vm-exports'],
    queryFn: vmTransferApi.exports,
    enabled: open,
    staleTime: 0,
    retry: false,
  });
  useEffect(() => {
    if (!open || !vm) return;
    setBusy(false);
    const existing = (jobsQuery.data?.jobs ?? []).find(
      (item) => item.node === vm.node && item.vmid === vm.vmid,
    );
    setJob(existing ?? null);
    // jobsQuery.data 只在打开/重新拉取时变化，不会因为 setJob 再次触发
  }, [open, vm, jobsQuery.data]);

  /* 这台机器导出过的**全部**产物（不只最近一次）。
     以前只取第一个匹配的作业：同一台机器导出两回，前一份就再也看不见、删不掉了，
     而它仍占着磁盘。 */
  const exported = useMemo(
    () =>
      (jobsQuery.data?.jobs ?? []).filter(
        (item) =>
          item.node === vm?.node && item.vmid === vm?.vmid && item.status === 'done',
      ),
    [jobsQuery.data, vm],
  );

  /* 只有还没结束的作业（以及失败了要给人看的）才单独占一张卡片。
     已完成的走下面的产物列表 —— 两处都显示同一份产物，用户会以为导了两遍。 */
  const activeJob = job && job.status !== 'done' ? job : null;

  const jobId = job?.id ?? '';
  const jobStatus = job?.status ?? '';
  useEffect(() => {
    if (!jobId || jobStatus !== 'running') return;
    const timer = window.setInterval(() => {
      void vmTransferApi
        .getExport(jobId)
        .then((res) => {
          setJob(res.job);
          // 刚跑完的这一下要刷新产物列表：结束的作业不再单独占一张卡片，
          // 它得出现在下面的「已导出的镜像」里
          if (res.job.status !== 'running') {
            void qc.invalidateQueries({ queryKey: ['vm-exports'] });
          }
        })
        .catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [jobId, jobStatus]);

  const start = async () => {
    if (!vm) return;
    setBusy(true);
    try {
      const res = await vmTransferApi.startExport(
        vm.node,
        vm.vmid,
        { format, storage, name: imageName.trim() || undefined },
        vm.connection_id,
      );
      setJob(res.job);
      toast.info(t('vmExport.started'), res.job.id);
    } catch (err) {
      toast.error(t('vmExport.startFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const cleanup = async () => {
    const target = cleanupTarget;
    if (!target) return;
    try {
      await vmTransferApi.deleteExport(target.id);
      toast.success(t('vmExport.cleaned'));
      if (job?.id === target.id) setJob(null);
      setCleanupTarget(null);
      void qc.invalidateQueries({ queryKey: ['vm-exports'] });
    } catch (err) {
      toast.error(t('vmExport.cleanFailed'), errorMessage(err));
    }
  };

  const stageText = (current: ExportJob) => {
    if (current.status === 'failed') return t('vmExport.stateFailed');
    if (current.status === 'done') return t('vmExport.stateDone');
    if (current.stage === 'preparing') return t('vmExport.statePreparing');
    if (current.stage === 'packing') return t('vmExport.statePacking');
    return t('vmExport.stateConverting');
  };

  return (
    <>
      <Modal
        open={open}
        onClose={busy ? () => undefined : onClose}
        title={t('vmExport.title', { name: vm?.name || `VM ${vm?.vmid ?? ''}` })}
        description={t('vmExport.subtitle')}
        size="md"
        closeOnOverlay={!busy}
        hideClose={busy}
        footer={
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              {t('common.close')}
            </Button>
            <Button
              variant="primary"
              icon={<IconDownload size={14} />}
              onClick={() => void start()}
              loading={busy}
              disabled={!stopped || !storage || job?.status === 'running'}
            >
              {t('vmExport.start')}
            </Button>
          </>
        }
      >
        <div className="dyn-list">
          {!stopped ? (
            <Notice tone="warning" title={t('vmExport.needStoppedTitle')}>
              {t('vmExport.needStoppedBody')}
            </Notice>
          ) : null}

          <div className="field-row">
            <Field label={t('vmExport.format')} hint={t('vmExport.formatHint')}>
              <Select
                value={format}
                onChange={(e) => setFormat(e.target.value)}
                options={FORMATS.map((item) => ({
                  label: t(item.labelKey),
                  value: item.value,
                }))}
                disabled={job?.status === 'running'}
              />
            </Field>
            <Field label={t('vmExport.targetStorage')} hint={t('vmExport.targetStorageHint')}>
              <Select
                value={storage}
                onChange={(e) => setStorage(e.target.value)}
                options={dirStorages.map((item) => ({
                  label: `${item.storage}（${item.type}）`,
                  value: item.storage,
                }))}
                disabled={!dirStorages.length || job?.status === 'running'}
              />
            </Field>
          </div>

          <Field label={t('vmExport.imageName')} hint={t('vmExport.imageNameHint')}>
            <Input
              value={imageName}
              onChange={(e) => setImageName(e.target.value)}
              placeholder={vm?.name || ''}
              disabled={job?.status === 'running'}
              maxLength={64}
            />
          </Field>

          {dirStorages.length ? null : (
            <Notice tone="warning">{t('vmExport.noDirStorage')}</Notice>
          )}

          <Notice tone="info">
            {format === 'ova' ? t('vmExport.ovaHint') : t('vmExport.imageHint')}
          </Notice>

          {activeJob ? (
            <div className="export-job">
              <div className="export-job-head">
                <Badge
                  variant={activeJob.status === 'failed' ? 'danger' : 'accent'}
                  size="sm"
                  pulse={activeJob.status === 'running'}
                >
                  {stageText(activeJob)}
                </Badge>
                <span className="fs-xs text-muted mono">{activeJob.id}</span>
              </div>
              <ProgressBar value={activeJob.progress} />
              {activeJob.detail ? (
                <div className="fs-xs text-muted">{activeJob.detail}</div>
              ) : null}
            </div>
          ) : null}

        {/* 已经导出的镜像：用户可以在这里下载或删除，不必再导一次 */}
          {exported.length ? (
            <div className="export-history">
              <div className="section-label">{t('vmExport.existing')}</div>
              {exported.map((item) => (
                <div className="export-job" key={item.id}>
                  <div className="export-job-head">
                    <Badge variant="success" size="sm">
                      {t('vmExport.stateDone')}
                    </Badge>
                    <span className="fs-xs text-muted mono">{item.id}</span>
                    {item.orphan ? (
                      <span className="fs-xs text-muted">{t('vmExport.orphan')}</span>
                    ) : null}
                  </div>
                  <div className="export-files">
                    {item.files.map((file) => (
                      <div className="export-file" key={file.name}>
                        <span className="mono fs-sm">{file.name}</span>
                        <span className="fs-xs text-muted">{formatBytes(file.size)}</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<IconDownload size={14} />}
                          onClick={() =>
                            window.open(
                              vmTransferApi.exportDownloadUrl(item.id, file.name),
                              '_blank',
                            )
                          }
                        >
                          {t('vmExport.download')}
                        </Button>
                      </div>
                    ))}
                  </div>
                  <div className="export-job-foot">
                    {/* 一次导出不止一个文件时（VMDK 就是「每块盘一个 + 一份 .vmx」），
                        逐个下再自己凑到一个目录里最容易出错，给一个打包的 */}
                    {item.files.length > 1 ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={<IconDownload size={14} />}
                        onClick={() =>
                          window.open(vmTransferApi.exportArchiveUrl(item.id), '_blank')
                        }
                      >
                        {t('vmExport.downloadAll')}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<IconTrash size={14} />}
                      onClick={() => setCleanupTarget(item)}
                    >
                      {t('vmExport.cleanup')}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(cleanupTarget)}
        title={t('vmExport.cleanupTitle')}
        message={t('vmExport.cleanupMessage')}
        danger
        confirmText={t('vmExport.cleanupConfirm')}
        onCancel={() => setCleanupTarget(null)}
        onConfirm={() => void cleanup()}
      />
    </>
  );
}
