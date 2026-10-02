/* ==========================================================================
   ProxCenter — 资源规格（套餐）管理
   ==========================================================================

   管理员在这里定义「几核 / 几 G 内存 / 多大盘」，用户在下单页直接挑一个 ——
   不必再自己算资源，也不会出现「建到一半发现内存给多了」。

   几个刻意的取舍：

   * **内存用 GB 填**（后端与 PVE 用 MB）：日常说「2G、4G」，让人换算成 2048 会
     填错；允许小数（0.5 = 512 MB），容器的小规格也表达得了。
   * **整份覆盖保存**（与 IP 池同一契约）：本地随便改，点保存才落库；不合法的行
     由后端逐条丢弃，返回值才是真正生效的那份，保存后以返回值回显。
   * 规格**只是数字**，不参与配额判定（配额是「能下发几台」，见创建默认值那一节）。
   ========================================================================== */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { configApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { Card, CardHeader } from './ui/Card';
import { Button, IconButton } from './ui/Button';
import { Field, Input, Select } from './ui/Input';
import { Badge } from './ui/Badge';
import { Notice } from './ui/EmptyState';
import { IconPlus, IconRefresh, IconTrash } from './Icons';
import { useToast } from '../hooks/useToast';
import { useAuth } from '../hooks/useAuth';
import type { ResourceSpec } from '../api/types';

/** 编辑用的行：内存按 GB 存（人填的单位），提交时换算成 MB */
interface SpecDraft {
  id: string;
  name: string;
  kind: 'vm' | 'lxc' | 'both';
  cores: string;
  memoryGb: string;
  disk: string;
  description: string;
}

const KIND_LABEL: Record<SpecDraft['kind'], string> = {
  both: '通用',
  vm: '仅虚拟机',
  lxc: '仅容器',
};

function toDraft(spec: ResourceSpec): SpecDraft {
  /* MB → GB：512 这种整数 MB 用 0.5 表示，别显示成 0.5000001 */
  const gb = spec.memory / 1024;
  return {
    id: spec.id,
    name: spec.name,
    kind: spec.kind ?? 'both',
    cores: String(spec.cores),
    memoryGb: String(Number(gb.toFixed(2))),
    disk: String(spec.disk),
    description: spec.description ?? '',
  };
}

/** 草稿 → 提交体。空/非数字的字段交给后端回落默认值，这里只做单位换算。 */
function toPayload(draft: SpecDraft): ResourceSpec {
  const gb = Number(draft.memoryGb);
  return {
    id: draft.id,
    name: draft.name.trim(),
    kind: draft.kind,
    cores: Number(draft.cores) || 0,
    memory: Math.round((Number.isFinite(gb) ? gb : 0) * 1024),
    disk: Number(draft.disk) || 0,
    description: draft.description.trim(),
  };
}

const KINDS: Array<{ value: SpecDraft['kind']; label: string }> = [
  { value: 'both', label: '通用（虚拟机 + 容器）' },
  { value: 'vm', label: '仅虚拟机' },
  { value: 'lxc', label: '仅容器' },
];

export function ResourceSpecsPanel() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('settings.manage');

  const [drafts, setDrafts] = useState<SpecDraft[]>([]);
  const loadedRef = useRef(false);

  const query = useQuery({
    queryKey: ['config', 'specs'],
    queryFn: configApi.getSpecs,
    staleTime: 30_000,
    retry: false,
  });

  useEffect(() => {
    /* 只在首次拿到数据时灌进表单：之后用户改到一半被轮询覆盖会很难受 */
    if (!query.data || loadedRef.current) return;
    loadedRef.current = true;
    setDrafts(query.data.specs.map(toDraft));
  }, [query.data]);

  const saved = useMemo(
    () => (query.data?.specs ?? []).map(toDraft),
    [query.data],
  );

  const dirty = useMemo(
    () => JSON.stringify(drafts) !== JSON.stringify(saved),
    [drafts, saved],
  );

  const save = useMutation({
    mutationFn: (items: ResourceSpec[]) => configApi.saveSpecs(items),
    onSuccess: (result) => {
      /* 以服务端返回为准：不合法的行会被丢掉，直接回显这份才不会有落差 */
      setDrafts(result.specs.map(toDraft));
      queryClient.setQueryData(['config', 'specs'], result);
      queryClient.invalidateQueries({ queryKey: ['config', 'specs'] });
      toast.success('已保存', `当前 ${result.specs.length} 个规格`);
    },
    onError: (err) => toast.error('保存失败', errorMessage(err)),
  });

  const update = (index: number, patch: Partial<SpecDraft>) =>
    setDrafts((list) =>
      list.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );

  const addRow = () =>
    setDrafts((list) => [
      ...list,
      {
        id: '',
        name: '',
        kind: 'both',
        cores: '2',
        memoryGb: '4',
        disk: '100',
        description: '',
      },
    ]);

  const removeRow = (index: number) =>
    setDrafts((list) => list.filter((_, i) => i !== index));

  return (
    <Card>
      <CardHeader
        title="资源规格"
        subtitle="用户下单时挑的套餐：几核、多少内存、多大磁盘"
        actions={
          canManage ? (
            <div className="flex items-center gap-8">
              <Button
                variant="secondary"
                icon={<IconRefresh size={14} />}
                disabled={!dirty || save.isPending}
                onClick={() => setDrafts(saved)}
              >
                放弃修改
              </Button>
              <Button
                variant="primary"
                loading={save.isPending}
                disabled={!dirty || drafts.length === 0}
                onClick={() => save.mutate(drafts.map(toPayload))}
              >
                保存
              </Button>
            </div>
          ) : undefined
        }
      />

      {query.isError ? (
        <Notice tone="warning" title="读取失败">
          {errorMessage(query.error)}
        </Notice>
      ) : null}

      {!canManage ? (
        <Notice tone="info" title="只读">
          修改资源规格需要管理员权限（settings.manage）。
        </Notice>
      ) : null}

      {drafts.length === 0 && !query.isLoading ? (
        <Notice tone="info" title="还没有规格">
          添加几个套餐后，用户就能在下单页直接选择。例如「2C4G · 100G」。
        </Notice>
      ) : null}

      <div className="flex flex-col gap-12">
        {drafts.map((draft, index) => (
          <div className="spec-row" key={draft.id || `new-${index}`}>
            <div className="spec-row-head">
              <Badge variant="accent" size="sm">
                {Number(draft.cores) || 0}C · {Number(draft.memoryGb) || 0}G ·{' '}
                {Number(draft.disk) || 0}G
              </Badge>
              <span className="fs-xs text-muted">{KIND_LABEL[draft.kind]}</span>
              <span className="spec-row-spacer" />
              {canManage ? (
                <IconButton
                  label={`删除规格 ${draft.name || index + 1}`}
                  variant="danger"
                  onClick={() => removeRow(index)}
                >
                  <IconTrash size={15} />
                </IconButton>
              ) : null}
            </div>

            <div className="spec-row-grid">
              <Field label="名称">
                <Input
                  value={draft.name}
                  disabled={!canManage}
                  placeholder="如：标准型 2C4G"
                  onChange={(e) => update(index, { name: e.target.value })}
                />
              </Field>
              <Field label="适用">
                <Select
                  value={draft.kind}
                  disabled={!canManage}
                  options={KINDS}
                  onChange={(e) =>
                    update(index, { kind: e.target.value as SpecDraft['kind'] })
                  }
                />
              </Field>
              <Field label="核数">
                <Input
                  value={draft.cores}
                  disabled={!canManage}
                  inputMode="numeric"
                  onChange={(e) =>
                    update(index, { cores: e.target.value.replace(/[^\d]/g, '') })
                  }
                />
              </Field>
              <Field label="内存（GB）">
                <Input
                  value={draft.memoryGb}
                  disabled={!canManage}
                  inputMode="decimal"
                  onChange={(e) =>
                    update(index, {
                      memoryGb: e.target.value.replace(/[^\d.]/g, ''),
                    })
                  }
                />
              </Field>
              <Field label="磁盘（GB）">
                <Input
                  value={draft.disk}
                  disabled={!canManage}
                  inputMode="numeric"
                  onChange={(e) =>
                    update(index, { disk: e.target.value.replace(/[^\d]/g, '') })
                  }
                />
              </Field>
              <Field label="说明">
                <Input
                  value={draft.description}
                  disabled={!canManage}
                  placeholder="如：常规业务、小型数据库"
                  onChange={(e) => update(index, { description: e.target.value })}
                />
              </Field>
            </div>
          </div>
        ))}
      </div>

      {canManage ? (
        <div className="mt-12">
          <Button variant="secondary" icon={<IconPlus size={14} />} onClick={addRow}>
            添加规格
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
