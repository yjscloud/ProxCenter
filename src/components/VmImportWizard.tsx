/* ==========================================================================
   ProxCenter — 从 OVF/OVA 导入虚拟机（VMware 互操作）

   为什么做成三步而不是一张表单：导入的输入是「一个文件」，而这个文件里已经
   写好了内存、核数、磁盘清单 —— 用户真正要做的是**核对**这些从别处机器带过来
   的参数，而不是自己填一遍。所以流程是：先把文件放上来 → 面板读出 OVF 里的
   配置摆出来 → 用户只改真正需要改的几项（落地的存储、网桥、磁盘控制器）。

   两个必须提醒的点。PVE 的 OVF 解析器只把控制器解析成**总线**（ide / scsi / sata）
   ——它从不读 rasd:ResourceSubType，所以「源机器用的是 LSI Logic 还是 PVSCSI」这条
   信息 PVE 给不出来。于是：固件跟随 OVF（vmw:Config firmware，PVE 会解析成 bios）；
   磁盘总线也跟随源文件（装系统时用的那个控制器，客户机 initramfs 里才有驱动）；
   控制器型号只能按最可能的选 —— BIOS 配 lsi、UEFI 配 virtio-scsi（UEFI 下 lsi 引导
   不了，PVE 自己会为此返回 ovmf-with-lsi-unsupported）。
   ========================================================================== */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ipPoolsApi, nodesApi, storagesApi, vmTransferApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { useTaskRunner } from '../hooks/useTaskRunner';
import { useToast } from '../hooks/useToast';
import { useT, type MessageKey } from '../i18n';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { Field, Input, Select, Switch, Textarea } from './ui/Input';
import { Badge } from './ui/Badge';
import { Notice } from './ui/EmptyState';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { Spinner } from './ui/Spinner';
import { ProgressBar } from './ui/ProgressBar';
import { IconTrash, IconUpload } from './Icons';
import type { ImportMetadata, ImportSource, ImportWarning } from '../api/types';
import { formatBytes } from '../utils/format';

export interface VmImportWizardProps {
  open: boolean;
  onClose: () => void;
  /** 建机成功（拿到 UPID 后）回调，参数是新虚拟机的 id */
  onCreated: (vmid: number) => void;
}

const WARNING_KEY: Record<string, MessageKey> = {
  'ova-needs-extracting': 'vmImport.warnOvaExtract',
  'ovmf-with-lsi-unsupported': 'vmImport.warnOvmfLsi',
  /* 面板自己加的：OVF 里没写固件类型（PVE 读不到），按 BIOS 建机可能起不来 */
  'firmware-not-declared': 'vmImport.warnFirmwareUnknown',
  'efi-state-lost': 'vmImport.warnEfiLost',
  /* 面板自己加的：盘在 SCSI 上、固件是 UEFI —— 这一格只能给 virtio-scsi，而 VMware
     搬来的客户机里多半没这个驱动（实测踩过：把盘挂回 IDE 才起来）。 */
  'scsi-under-ovmf': 'vmImport.warnScsiUnderOvmf',
  'cdrom-image-ignored': 'vmImport.warnCdrom',
  'nvme-unsupported': 'vmImport.warnNvme',
  'serial-port-socket-only': 'vmImport.warnSerial',
  'guest-is-running': 'vmImport.warnGuestRunning',
};

/* PVE 的 import 内容**在上传接口上**只接受这四种磁盘镜像（`$UPLOAD_IMPORT_EXT_RE_1
   = \.(ova|qcow2|raw|vmdk)`）。散开的 .ovf 例外：它只是描述文件，盘数据在同名的
   -diskN.vmdk 里，上传接口没有「一次传一组」的形式 —— 传上去 PVE 直接回
   `filename: invalid filename or wrong extension`。所以 .ovf 要由用户 scp 进宿主机
   该存储的 import 目录（面板读的就是同一个目录），再从这里选。
   .img / .vhd / .vhdx 两处都不收（先在本地转成 qcow2 或 raw）。 */
const IMPORT_ACCEPT = '.ova,.qcow2,.raw,.vmdk';
const IMPORT_RE = /\.(ova|qcow2|raw|vmdk)$/i;
const OVF_RE = /\.ovf$/i;
const COMPANION_RE = /\.(mf|nvram|vmsd|vmsn|vmem)$/i;
/** 描述文件：导入时要选的是它，而不是磁盘文件 */
const DESCRIPTOR_RE = /\.(ova|ovf)$/i;

const NET_MODEL_KEYS = [
  { value: '', labelKey: 'vmImport.netModelAuto', label: '' },
  { value: 'virtio', labelKey: '', label: 'virtio' },
  { value: 'e1000', labelKey: '', label: 'e1000' },
  { value: 'e1000e', labelKey: '', label: 'e1000e' },
  { value: 'vmxnet3', labelKey: '', label: 'vmxnet3' },
  { value: 'rtl8139', labelKey: '', label: 'rtl8139' },
] as const;

export function VmImportWizard({ open, onClose, onCreated }: VmImportWizardProps) {
  const t = useT();
  const toast = useToast();
  const runner = useTaskRunner();
  const qc = useQueryClient();

  const [step, setStep] = useState(0);
  const [node, setNode] = useState('');
  const [sourceStorage, setSourceStorage] = useState('');
  const [volume, setVolume] = useState('');
  const [meta, setMeta] = useState<ImportMetadata | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [busy, setBusy] = useState(false);

  /* 上传。选中的是一组文件（整套 OVF 导出），逐个传进同一个 import 目录 */
  const fileRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  /* 多文件时的「第几个 / 共几个」，单文件不需要显示 */
  const [uploadStep, setUploadStep] = useState({ index: 0, total: 0 });

  /* 第二步要核对的落地参数 */
  const [name, setName] = useState('');
  const [vmid, setVmid] = useState('');
  const [targetStorage, setTargetStorage] = useState('');
  const [memory, setMemory] = useState('');
  const [cores, setCores] = useState('');
  const [bridge, setBridge] = useState('vmbr0');
  /* '' = 跟随 OVF：PVE 已经把源文件的控制器类型解析出来了（元数据里磁盘键的前缀），
     沿用它才最有可能一次开机成功 —— 换控制器等于换驱动，客户机的 initramfs 里没有
     那个驱动的例子太多了。 */
  const [bus, setBus] = useState('');
  const [diskFormat, setDiskFormat] = useState('qcow2');
  /* '' = 跟随 OVF：VMware 导出的 OVF 里记着固件类型，PVE 会解析出来（bios=ovmf）。
     裸磁盘镜像没有这份描述，跟随会落到传统 BIOS。 */
  const [firmware, setFirmware] = useState('');
  const [cpu, setCpu] = useState('x86-64-v2-AES');
  /* '' = 跟随 OVF：PVE 只给得出总线、给不出控制器型号（源机是 LSI Logic 还是
     PVSCSI 它不解析），所以这一格由后端按「BIOS → lsi、UEFI → virtio-scsi」定。
     写死 virtio-scsi-single 正是「开机后内核起来了却找不到盘」的成因。 */
  const [scsihw, setScsihw] = useState('');
  /* 裸磁盘镜像里没有机器配置，这一步的默认值得由我们给，而不是留三个空框 */
  const [bare, setBare] = useState(false);
  const [netModel, setNetModel] = useState('');
  const [ciUser, setCiUser] = useState('');
  const [ciPassword, setCiPassword] = useState('');
  const [sshKeys, setSshKeys] = useState('');
  const [startAfter, setStartAfter] = useState(true);
  const [cleanupFile, setCleanupFile] = useState<ImportSource | null>(null);
  /* 建机任务的 UPID：createImport 立刻就会返回它（不用等任务跑完），所以任务还在
     进行中时就能查进度 —— 导入几十 GB 要好几分钟，界面上什么都看不到的话，
     分不清「在跑」和「卡死」。 */
  const [importUpid, setImportUpid] = useState('');
  const progressQuery = useQuery({
    queryKey: ['vm-import', 'progress', importUpid],
    queryFn: () => vmTransferApi.importProgress(importUpid, node),
    enabled: Boolean(importUpid) && busy,
    refetchInterval: 3000,
    retry: false,
  });
  const [deleting, setDeleting] = useState(false);
  /* '' = 保持镜像 / OVF 里原有的网络配置不动 */
  const [ipMode, setIpMode] = useState('');
  const [poolId, setPoolId] = useState('');
  const [ip, setIp] = useState('');
  const [gateway, setGateway] = useState('');
  const [dns, setDns] = useState('');

  /* 网卡型号。留空 = 沿用 OVF 里写的（实测 PVE 9.2 常给 vmxnet3），这样导入出来
     的机器最贴近源机器；用户想换再选。virtio 性能最好但要系统里有驱动，
     e1000/e1000e 是从别处搬来的系统几乎都认的老型号。 */
  const netModelOptions = useMemo(
    () =>
      NET_MODEL_KEYS.map((item) => ({
        value: item.value,
        label: item.labelKey ? t(item.labelKey) : item.label,
      })),
    [t],
  );

  /* ---- 静态 IP 时从地址池推荐一个未分配的地址 ----
     后端 GET /api/ip-pools 已经把每个池的空闲地址算好了（free[] 里是**裸 IP**），
     这里只负责挑一个、补上掩码、带上网关与 DNS —— 和 QuickDeployForm /
     VmCreateWizard 是同一套做法，没有新增接口。 */
  const poolsQuery = useQuery({
    queryKey: ['ip-pools'],
    queryFn: ipPoolsApi.get,
    enabled: open && ipMode === 'static',
    staleTime: 30_000,
  });
  /* 只列网桥对得上的池：网段不在这个桥上，地址填了也连不上 */
  const usablePools = useMemo(
    () =>
      (poolsQuery.data?.pools ?? []).filter(
        (item) => !bridge || !item.bridge || item.bridge === bridge,
      ),
    [poolsQuery.data, bridge],
  );
  /* 用户手填过 IP 之后就别再自动覆盖了 —— 自动填充是为了省事，不是为了抢方向盘 */
  const ipTouched = useRef(false);
  /* 同上：用户自己改过总线之后，重新检查文件时不要再把默认值盖回去 */
  const busTouched = useRef(false);

  useEffect(() => {
    if (ipMode !== 'static') return;
    if (!poolId) {
      const first = usablePools.find((item) => (item.free?.length ?? 0) > 0);
      if (first) setPoolId(first.id);
      return;
    }
    if (ipTouched.current) return;
    const pool = usablePools.find((item) => item.id === poolId);
    const next = pool?.free?.[0];
    if (!next) return;
    // 池里的掩码藏在 subnet 的前缀里（192.168.1.0/24），free[] 是不带掩码的裸 IP。
    // 这里必须补上：后端 _import_ip_config 收不到 '/' 就直接拒绝，而少了掩码的地址
    // 会被 PVE 当成 /32，机器拿不到地址。
    const prefix = (pool?.subnet || '').split('/')[1] || '24';
    setIp(`${next}/${prefix}`);
    if (pool?.gateway) setGateway(pool.gateway);
    if (pool?.dns) setDns(pool.dns);
  }, [ipMode, poolId, usablePools]);

  const nodesQuery = useQuery({
    queryKey: ['nodes'],
    queryFn: nodesApi.list,
    enabled: open,
    staleTime: 60_000,
  });
  const nodes = nodesQuery.data ?? [];

  useEffect(() => {
    if (open && !node && nodes.length) setNode(nodes[0].node);
  }, [open, node, nodes]);

  const sourcesQuery = useQuery({
    queryKey: ['vm-import', 'sources', node],
    queryFn: () => vmTransferApi.importSources(node),
    enabled: open && Boolean(node),
    retry: false,
  });

  const storagesQuery = useQuery({
    queryKey: ['storages', 'list', node],
    queryFn: () => storagesApi.list(node),
    enabled: open && Boolean(node),
    staleTime: 60_000,
    retry: false,
  });

  /* 导入源存储：支持 import 内容类型的那种；落地存储：能放 images 的 */
  const importStorages = sourcesQuery.data?.storages ?? [];
  const targetStorages = useMemo(
    () =>
      (storagesQuery.data ?? []).filter((s) =>
        String(s.content ?? '')
          .split(',')
          .some((c) => c === 'images' || c === 'rootdir'),
      ),
    [storagesQuery.data],
  );
  const sources = (sourcesQuery.data?.sources ?? []).filter(
    (item) => !sourceStorage || item.storage === sourceStorage,
  );

  /* 当前导入源存储在宿主机上的 import 目录（后端从 /storage 的 path 拼出来）。
     散开的 OVF 只能靠 scp 放进这里，所以提示里要带具体路径 ——「请放进 import 目录」
     但不说在哪，等于让用户自己去翻。 */
  const importDir = (() => {
    const item = importStorages.find((s) => s.storage === sourceStorage);
    return item?.path ? `${item.path}/import/` : '';
  })();
  /* 选中了裸磁盘、而同一个 import 目录里正好躺着一个同名的 .ovf 时提醒一句。
     这是「导出目录里四个文件、面板只让选一个」之后的典型岔路：用户随手挑了那个
     1.5GB 的 .vmdk（看着最像「系统」），于是内存 / 控制器 / 固件全靠猜。OVF 就在
     旁边，选它能把这些都带上。 */
  const siblingOvf = (() => {
    const name = (volume || '').split('/').pop() ?? '';
    if (!/\.(vmdk|qcow2|raw|img|vhd|vhdx)$/i.test(name)) return '';
    const base = name.replace(/\.[^.]+$/, '').replace(/-disk\d+$/i, '');
    if (!base) return '';
    const hit = sources.find(
      (item) => item.name.toLowerCase() === `${base}.ovf`.toLowerCase(),
    );
    return hit ? hit.name : '';
  })();

  useEffect(() => {
    if (open && !sourceStorage && importStorages.length) {
      setSourceStorage(importStorages[0].storage);
    }
  }, [open, sourceStorage, importStorages]);

  useEffect(() => {
    if (open && !targetStorage && targetStorages.length) {
      setTargetStorage(targetStorages[0].storage);
    }
  }, [open, targetStorage, targetStorages]);

  /* 每次打开都回到第一步：向导是「一次性」的，留着上次的进度只会让人误点 */
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setMeta(null);
    setVolume('');
    setFiles([]);
    setProgress(0);
    setUploadStep({ index: 0, total: 0 });
    setName('');
    setVmid('');
    setMemory('');
    setCores('');
    setBare(false);
    setNetModel('');
    setDiskFormat('qcow2');
    setBus('');
    setFirmware('');
    setScsihw('');
    setCpu('x86-64-v2-AES');
    setCiUser('');
    setCiPassword('');
    setSshKeys('');
    setStartAfter(true);
    setIpMode('');
    setPoolId('');
    ipTouched.current = false;
    busTouched.current = false;
    setIp('');
    setGateway('');
    setDns('');
    setCleanupFile(null);
    setImportUpid('');
  }, [open]);

  /* 选中文件时先把不能走上传的挑出来，并且**分两类说**：
     * .mf / .nvram 这类伴生文件：不用传，PVE 也用不到；
     * .ovf：绝对传不上去（PVE 的上传接口只认磁盘镜像），但它恰恰是导入 OVF 时必须选中的
       那个文件 —— 之前只丢一句「不支持」，用户就卡在这里了。要把「该把它放哪儿」讲清楚。
     * 其余（.img/.vhd/.vhdx 等）：同样先转格式。 */
  const pickFiles = (picked: File[]) => {
    const usable: File[] = [];
    const companions: File[] = [];
    const descriptors: File[] = [];
    const unsupported: File[] = [];
    for (const item of picked) {
      if (COMPANION_RE.test(item.name)) companions.push(item);
      else if (OVF_RE.test(item.name)) descriptors.push(item);
      else if (IMPORT_RE.test(item.name)) usable.push(item);
      else unsupported.push(item);
    }
    if (companions.length) {
      toast.info(
        t('vmImport.skipCompanions', { n: companions.length }),
        companions.map((item) => item.name).join('、'),
      );
    }
    if (descriptors.length) {
      toast.error(
        t('vmImport.ovfNeedsCopy'),
        t('vmImport.ovfNeedsCopyBody', {
          dir: importDir || t('vmImport.importDirUnknown'),
        }),
      );
    }
    if (unsupported.length) {
      toast.error(t('vmImport.pickUnsupported'), unsupported.map((item) => item.name).join('、'));
    }
    setFiles(usable);
  };

  const doUpload = async () => {
    if (!files.length || !node || !sourceStorage) {
      toast.warning(t('vmImport.needFile'));
      return;
    }
    setUploading(true);
    setProgress(0);
    setUploadStep({ index: 0, total: files.length });
    /* 整套上传时最后要选中的那个：优先描述文件（.ovf / .ova），其次第一个传上去的。
       少了这一步，用户传完一整套还得自己去下拉里猜该选哪个 —— 选错那个（比如把
       -disk1.vmdk 当导入源）就会走成「裸磁盘导入」，参数全靠猜。 */
    let selected = '';
    try {
      for (let index = 0; index < files.length; index += 1) {
        const item = files[index];
        setUploadStep({ index: index + 1, total: files.length });
        const res = await vmTransferApi.uploadImport(
          { node, storage: sourceStorage },
          item,
          setProgress,
        );
        if (DESCRIPTOR_RE.test(item.name) || !selected) selected = res.volume;
      }
      toast.success(
        t('vmImport.uploadDone'),
        files.length > 1 ? t('vmImport.uploadDoneCount', { n: files.length }) : undefined,
      );
      setVolume(selected);
      setFiles([]);
      if (fileRef.current) fileRef.current.value = '';
      await sourcesQuery.refetch();
    } catch (err) {
      toast.error(t('vmImport.uploadFailed'), errorMessage(err));
    } finally {
      setUploading(false);
      setUploadStep({ index: 0, total: 0 });
    }
  };

  const inspect = async () => {
    if (!volume) {
      toast.warning(t('vmImport.needFile'));
      return;
    }
    setInspecting(true);
    try {
      const data = await vmTransferApi.inspectImport({
        node,
        storage: sourceStorage,
        volume,
      });
      setMeta(data);
      const args = data.create_args ?? {};
      // 裸磁盘镜像（PVE 解析不了，面板也不编）没有任何机器配置：给一套能开机的
      // 默认值让人改，而不是把内存、核数、名称三个框都留空 —— 留空的话下一步
      // 建出来的机器会是一台没有内存的。
      const isBare = Boolean(data.bare);
      const fromFile = (volume || '').split('/').pop()?.replace(/\.[^.]+$/, '') ?? '';
      /* 总线默认值：源文件声明的是 SCSI 时改用 **IDE**（与后端 resolve_bus 同一套
         规则，这里只是把它显示出来，免得下拉写着「跟随 OVF」而实际选了 IDE）。
         理由：PVE 只解析得出「SCSI」这个总线，型号（VMware 的 LSI Logic / PVSCSI）
         它给不出来，面板只能退到 virtio-scsi —— 而搬过来的客户机 initramfs 里几乎
         没有这个驱动，表现是「内核起来了却找不到根盘」，同一块盘挂回 IDE 就能起。
         源文件写明 SATA / IDE 时仍照它来：那种客户机里有 ahci / ata_piix。 */
      if (!isBare && !busTouched.current) {
        const declared = Object.keys(data.disks ?? {})
          .filter((key) => key !== 'efidisk0')
          .sort()
          .find((key) => /^(scsi|ide|sata|nvme)/.test(key));
        setBus(declared && /^scsi/.test(declared) ? 'ide' : '');
      }
      setBare(isBare);
      setName(String(args.name ?? '').trim() || fromFile);
      setMemory(String(args.memory ?? (isBare ? 2048 : '')));
      setCores(String(args.cores ?? (isBare ? 2 : '')));
      setStep(1);
    } catch (err) {
      toast.error(t('vmImport.inspectFailed'), errorMessage(err));
    } finally {
      setInspecting(false);
    }
  };

  /* 删掉一个已上传的导入文件。后端按归属判定：普通用户只能删自己上传的，
     别人的文件会得到 404（而不是 403 —— 403 等于承认那里确实有个文件）。 */
  const removeSource = async () => {
    const target = cleanupFile;
    if (!target) return;
    setDeleting(true);
    try {
      await vmTransferApi.deleteImportSource(node, target.storage, target.volume);
      toast.success(t('vmImport.deleteSourceDone'));
      if (volume === target.volume) setVolume('');
      setCleanupFile(null);
      void qc.invalidateQueries({ queryKey: ['vm-import', 'sources', node] });
    } catch (err) {
      toast.error(t('vmImport.deleteSourceFailed'), errorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    try {
      /* runner 只把 TaskInfo 交出来（里面没有 vmid），所以在请求时就把它
         另存一份 —— 否则后面提示里和 onCreated 拿到的都会是 0。 */
      let createdVmid = 0;
      setImportUpid('');
      await runner.run(
        vmTransferApi
          .createImport({
          node,
          storage: sourceStorage,
          volume,
          target_storage: targetStorage,
          name: name.trim(),
          vmid: vmid.trim() ? Number(vmid) : null,
          memory: memory ? Number(memory) : null,
          cores: cores ? Number(cores) : null,
          bridge,
          net_model: netModel,
          /* 「跟随 OVF」时这个字段**不发出去**（undefined 不会进 JSON），让后端用它
             自己的默认值。发一个空串的话，后端若是旧版本（不认识 ''）会直接回
             「不支持的磁盘总线：」—— 前后端版本错开时最容易撞上的那种坑。 */
          bus: bus || undefined,
          /* '' = 跟随 OVF：由后端按固件选（BIOS → lsi，UEFI → virtio-scsi）。与 bus
             一样发 undefined 而不是空串，免得旧后端把 '' 当成非法型号拒掉。 */
          scsihw: scsihw || undefined,
          disk_format: diskFormat,
          firmware,
          cpu,
          ip_mode: ipMode,
          ip: ipMode === 'static' ? ip.trim() : '',
          gateway: ipMode === 'static' ? gateway.trim() : '',
          dns: ipMode === 'static' ? dns.trim() : '',
          ci_user: ciUser.trim(),
          ci_password: ciPassword,
            ssh_keys: sshKeys.trim(),
            start: startAfter,
          })
          .then((r) => {
            createdVmid = r.vmid;
            setImportUpid(r.task);
            return r;
          }),
        {
          title: t('vmImport.taskTitle', { name: name || volume }),
          node,
          invalidate: [['vms'], ['nodes'], ['guests']],
        },
      );
      setImportUpid('');
      toast.success(t('vmImport.created', { vmid: createdVmid }));
      void qc.invalidateQueries({ queryKey: ['vm-import'] });
      onCreated(createdVmid);
      onClose();
    } catch (err) {
      toast.error(t('vmImport.createFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const stepLabel = [
    t('vmImport.stepSource'),
    t('vmImport.stepOptions'),
    t('vmImport.stepCreate'),
  ];

  return (
    <>
      <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title={t('vmImport.title')}
      description={t('vmImport.subtitle')}
      size="lg"
      closeOnOverlay={!busy}
      hideClose={busy}
      footer={
        <>
          {step > 0 ? (
            <Button
              variant="ghost"
              onClick={() => setStep(step - 1)}
              disabled={busy || uploading}
            >
              {t('vmImport.back')}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          {step === 0 ? (
            <Button
              variant="primary"
              onClick={() => void inspect()}
              loading={inspecting}
              disabled={!volume || uploading}
            >
              {t('vmImport.next')}
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => void submit()}
              loading={busy}
              disabled={!targetStorage}
            >
              {t('vmImport.start')}
            </Button>
          )}
        </>
      }
    >
      <div className="import-steps">
        {stepLabel.map((label, index) => (
          <span
            key={label}
            className={`import-step ${index === step ? 'is-active' : ''} ${
              index < step ? 'is-done' : ''
            }`}
          >
            <span className="import-step-no">{index + 1}</span>
            {label}
          </span>
        ))}
      </div>

      {step === 0 ? (
        <div className="dyn-list">
          <div className="field-row">
            <Field label={t('vmImport.node')}>
              <Select
                value={node}
                onChange={(e) => {
                  setNode(e.target.value);
                  setVolume('');
                }}
                options={nodes.map((item) => ({
                  label: item.node,
                  value: item.node,
                }))}
              />
            </Field>
            <Field label={t('vmImport.sourceStorage')} hint={t('vmImport.sourceStorageHint')}>
              <Select
                value={sourceStorage}
                onChange={(e) => {
                  setSourceStorage(e.target.value);
                  setVolume('');
                }}
                options={importStorages.map((item) => ({
                  label: `${item.storage}（${item.type}）`,
                  value: item.storage,
                }))}
                disabled={!importStorages.length}
              />
            </Field>
          </div>

          {/* 接口失败与「PVE 上确实没配 import 存储」是两回事：把前者说成后者
              会把人引去改 PVE 配置，实际什么都没错 */}
          {sourcesQuery.isError ? (
            <Notice tone="danger" title={t('vmImport.loadFailed')}>
              {errorMessage(sourcesQuery.error)}
            </Notice>
          ) : !importStorages.length && !sourcesQuery.isLoading ? (
            <Notice tone="warning" title={t('vmImport.noImportStorage')}>
              {t('vmImport.noImportStorageBody')}
            </Notice>
          ) : null}

          <Field label={t('vmImport.file')} hint={t('vmImport.fileHint')}>
            <div className="import-upload">
              <input
                ref={fileRef}
                type="file"
                multiple
                accept={IMPORT_ACCEPT}
                onChange={(e) => pickFiles(Array.from(e.target.files ?? []))}
                disabled={uploading || !sourceStorage}
              />
              <Button
                size="sm"
                variant="secondary"
                icon={<IconUpload size={14} />}
                onClick={() => void doUpload()}
                loading={uploading}
                disabled={!files.length || !sourceStorage}
              >
                {uploading
                  ? `${
                      uploadStep.total > 1 ? `${uploadStep.index}/${uploadStep.total} · ` : ''
                    }${t('vmImport.uploading', { percent: progress })}`
                  : t('vmImport.upload')}
              </Button>
            </div>
            {files.length ? (
              <div className="fs-xs text-muted">
                {t('vmImport.selectedFiles', { n: files.length })}：
                {files.map((item) => item.name).join('、')}
              </div>
            ) : null}
          </Field>

          <Field label={t('vmImport.pickExisting')} hint={t('vmImport.pickExistingHint')}>
            {sourcesQuery.isLoading ? (
              <Spinner />
            ) : (
              /* 选择与删除放在一起：这个下拉里列的就是 import 目录的全部文件，
                 用户选中哪个就是要操作哪个，不需要再列一遍。 */
              <div className="import-pick-row">
                <Select
                  value={volume}
                  onChange={(e) => setVolume(e.target.value)}
                  placeholder={t('vmImport.pickPlaceholder')}
                  options={sources.map((item) => ({
                    label: `${item.name}${item.size ? ` · ${formatBytes(item.size)}` : ''}`,
                    value: item.volume,
                  }))}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<IconTrash size={14} />}
                  disabled={!volume || deleting}
                  onClick={() =>
                    setCleanupFile(sources.find((item) => item.volume === volume) ?? null)
                  }
                >
                  {t('vmImport.deleteSource')}
                </Button>
              </div>
            )}
          </Field>

          {siblingOvf ? (
            <Notice tone="warning" title={t('vmImport.preferOvfTitle')}>
              {t('vmImport.preferOvf', { name: siblingOvf })}
            </Notice>
          ) : null}

          <Notice tone="info">
            {t('vmImport.howItWorks', {
              dir: importDir || t('vmImport.importDirUnknown'),
            })}
          </Notice>
        </div>
      ) : (
        <div className="dyn-list">
          {meta?.warnings?.length ? (
            <Notice tone="warning" title={t('vmImport.warnings')}>
              <ul className="import-warnings">
                {meta.warnings.map((w: ImportWarning, index: number) => (
                  <li key={`${w.type}-${index}`}>
                    {WARNING_KEY[w.type]
                      ? t(WARNING_KEY[w.type], { value: w.value ?? '' })
                      : t('vmImport.warnUnknown', { type: w.type })}
                  </li>
                ))}
              </ul>
            </Notice>
          ) : null}

          {bare ? (
            <Notice tone="info" title={t('vmImport.bareTitle')}>
              {t('vmImport.bareNotice')}
            </Notice>
          ) : null}

          <div className="field-row">
            <Field label={t('common.name')}>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label={t('vmImport.vmid')} hint={t('vmImport.vmidHint')}>
              <Input
                value={vmid}
                onChange={(e) => setVmid(e.target.value.replace(/\D/g, ''))}
                placeholder={t('vmImport.vmidAuto')}
                mono
              />
            </Field>
          </div>

          <div className="field-row">
            <Field label={t('vmImport.targetStorage')} required hint={t('vmImport.targetStorageHint')}>
              <Select
                value={targetStorage}
                onChange={(e) => setTargetStorage(e.target.value)}
                options={targetStorages.map((item) => ({
                  label: `${item.storage}（${item.type}）`,
                  value: item.storage,
                }))}
              />
            </Field>
            <Field label={t('vmImport.memory')}>
              <Input
                type="number"
                min={256}
                value={memory}
                onChange={(e) => setMemory(e.target.value)}
              />
            </Field>
            <Field label={t('vmImport.cores')}>
              <Input
                type="number"
                min={1}
                value={cores}
                onChange={(e) => setCores(e.target.value)}
              />
            </Field>
          </div>

          <div className="field-row">
            <Field label={t('vmImport.bridge')}>
              <Input value={bridge} onChange={(e) => setBridge(e.target.value)} mono />
            </Field>
            <Field label={t('vmImport.netModel')} hint={t('vmImport.netModelHint')}>
              <Select
                value={netModel}
                onChange={(e) => setNetModel(e.target.value)}
                options={netModelOptions}
                disabled={busy}
              />
            </Field>
            <Field
              label={t('vmImport.firmware')}
              hint={t('vmImport.firmwareHint')}
            >
              <Select
                value={firmware}
                onChange={(e) => setFirmware(e.target.value)}
                options={[
                  { label: t('vmImport.firmwareAuto'), value: '' },
                  { label: t('vmImport.firmwareBios'), value: 'seabios' },
                  { label: t('vmImport.firmwareUefi'), value: 'ovmf' },
                ]}
                disabled={busy}
              />
            </Field>
            <Field label={t('vmImport.cpu')} hint={t('vmImport.cpuHint')}>
              <Select
                value={cpu}
                onChange={(e) => setCpu(e.target.value)}
                options={[
                  { label: 'x86-64-v2-AES', value: 'x86-64-v2-AES' },
                  { label: 'host', value: 'host' },
                  { label: 'x86-64-v2', value: 'x86-64-v2' },
                  { label: 'qemu64', value: 'qemu64' },
                ]}
                disabled={busy}
              />
            </Field>
            <Field
              label={t('vmImport.diskFormat')}
              hint={t('vmImport.diskFormatHint')}
            >
              <Select
                value={diskFormat}
                onChange={(e) => setDiskFormat(e.target.value)}
                options={[
                  { label: 'qcow2', value: 'qcow2' },
                  { label: 'raw', value: 'raw' },
                  { label: 'vmdk', value: 'vmdk' },
                ]}
                disabled={busy}
              />
            </Field>
            <Field label={t('vmImport.bus')} hint={t('vmImport.busHint')}>
              <Select
                value={bus}
                onChange={(e) => {
                  busTouched.current = true;
                  setBus(e.target.value);
                }}
                options={[
                  { label: t('vmImport.busAuto'), value: '' },
                  { label: 'IDE', value: 'ide' },
                  { label: 'SATA', value: 'sata' },
                  { label: 'SCSI', value: 'scsi' },
                  { label: 'VirtIO', value: 'virtio' },
                ]}
              />
            </Field>
            <Field label={t('vmImport.scsihw')} hint={t('vmImport.scsihwHint')}>
              <Select
                value={scsihw}
                onChange={(e) => setScsihw(e.target.value)}
                options={[
                  { label: t('vmImport.scsihwAuto'), value: '' },
                  { label: 'virtio-scsi-single', value: 'virtio-scsi-single' },
                  { label: 'virtio-scsi-pci', value: 'virtio-scsi-pci' },
                  { label: 'lsi', value: 'lsi' },
                  { label: 'megasas', value: 'megasas' },
                  { label: 'pvscsi', value: 'pvscsi' },
                ]}
              />
            </Field>
          </div>

          {/* ---- IP 分配：同样经 cloud-init 注入，所以选了就一定会挂上 cloud-init 盘 ---- */}
          {busy && importUpid ? (
            <div className="import-progress">
              <ProgressBar value={progressQuery.data?.percent ?? 0} />
              <div className="fs-xs text-muted">
                {progressQuery.data?.transferred
                  ? `${t('vmImport.progressLabel')} ${progressQuery.data.transferred} / ${progressQuery.data.total}（${Math.round(progressQuery.data.percent)}%）`
                  : t('vmImport.progressPending')}
              </div>
            </div>
          ) : null}

          <div className="section-label">{t('vmImport.ipSection')}</div>
          <div className="field-row">
            <Field label={t('vmImport.ipMode')} hint={t('vmImport.ipModeHint')}>
              <Select
                value={ipMode}
                onChange={(e) => {
                  ipTouched.current = false;
                  setIpMode(e.target.value);
                }}
                options={[
                  { label: t('vmImport.ipKeep'), value: '' },
                  { label: t('vmReinstall.ipModeDhcp'), value: 'dhcp' },
                  { label: t('vmReinstall.ipModeStatic'), value: 'static' },
                ]}
                disabled={busy}
              />
            </Field>
          </div>
          {ipMode === 'static' ? (
            <>
              <div className="field-row">
                <Field label={t('vmCreate.nicPool')} hint={t('vmCreate.poolHint')}>
                  <Select
                    value={poolId}
                    onChange={(e) => {
                      // 换池等于换一个网段，之前自动填的地址作废，重新取一个
                      ipTouched.current = false;
                      setPoolId(e.target.value);
                    }}
                    options={[
                      { label: t('vmCreate.poolManual'), value: '' },
                      ...usablePools.map((item) => ({
                        label: `${item.name || item.subnet} · ${item.subnet}（${t(
                          'ippool.freeCount',
                          { n: item.free_count },
                        )}）`,
                        value: item.id,
                      })),
                    ]}
                    disabled={busy || poolsQuery.isLoading}
                  />
                </Field>
              </div>
              {!poolsQuery.isLoading && !usablePools.length ? (
                <Notice tone="warning">{t('vmCreate.poolHintEmpty')}</Notice>
              ) : null}
              {poolId && !(usablePools.find((item) => item.id === poolId)?.free?.length ?? 0) ? (
                <Notice tone="warning">{t('vmCreate.poolEmpty')}</Notice>
              ) : null}
              <div className="field-row">
              <Field label={t('vmReinstall.ip')} hint={t('vmImport.ipHint')}>
                <Input
                  value={ip}
                  onChange={(e) => {
                    ipTouched.current = true;
                    setIp(e.target.value);
                  }}
                  placeholder="192.168.1.10/24"
                  mono
                />
              </Field>
              <Field label={t('vmReinstall.gateway')}>
                <Input
                  value={gateway}
                  onChange={(e) => setGateway(e.target.value)}
                  placeholder="192.168.1.1"
                  mono
                />
              </Field>
              <Field label={t('vmReinstall.dns')}>
                <Input
                  value={dns}
                  onChange={(e) => setDns(e.target.value)}
                  placeholder="223.5.5.5"
                  mono
                />
              </Field>
            </div>
            </>
          ) : null}

          {/* ---- 首次登录：走 cloud-init，导入的机器和重装系统共用同一套机制 ---- */}
          <div className="section-label">{t('vmImport.credentials')}</div>
          <Notice tone="info" title={t('vmImport.ciTitle')}>
            {t('vmImport.ciHint')}
          </Notice>
          <div className="field-row">
            <Field label={t('vmImport.ciUser')}>
              <Input
                value={ciUser}
                onChange={(e) => setCiUser(e.target.value)}
                mono
                placeholder="root"
              />
            </Field>
            <Field label={t('vmImport.ciPassword')}>
              <Input
                type="password"
                value={ciPassword}
                onChange={(e) => setCiPassword(e.target.value)}
                autoComplete="new-password"
              />
            </Field>
          </div>
          <Field label={t('vmImport.sshKeys')} hint={t('vmImport.sshKeysHint')}>
            <Textarea
              value={sshKeys}
              onChange={(e) => setSshKeys(e.target.value)}
              rows={3}
              mono
            />
          </Field>

          <div className="section-label">{t('vmImport.misc')}</div>
          <Field label={t('vmImport.startAfter')} hint={t('vmImport.startAfterHint')}>
            <Switch checked={startAfter} onChange={setStartAfter} />
          </Field>

          <Field label={t('vmImport.disks')}>
            <div className="import-disks">
              {Object.entries(meta?.disks ?? {}).map(([key, value]) => {
                const volid = typeof value === 'string' ? value : value?.volid ?? '';
                const size = typeof value === 'string' ? 0 : value?.size ?? 0;
                return (
                  <div className="import-disk" key={key} title={volid}>
                    <Badge variant="accent" size="sm">
                      {key}
                    </Badge>
                    <span className="mono fs-xs text-muted">{volid}</span>
                    {size ? (
                      <span className="fs-xs text-muted">{formatBytes(size)}</span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </Field>

          <Notice tone="info" title={t('vmImport.createHintTitle')}>
            {t('vmImport.createHint')}
          </Notice>
        </div>
      )}
      </Modal>

      <ConfirmDialog
        open={Boolean(cleanupFile)}
        title={t('vmImport.deleteSourceTitle')}
        message={
          cleanupFile
            ? t('vmImport.deleteSourceMessage', { name: cleanupFile.name })
            : ''
        }
        danger
        confirmText={t('vmImport.deleteSourceConfirm')}
        onCancel={() => setCleanupFile(null)}
        onConfirm={() => void removeSource()}
      />
    </>
  );
}
