/* ==========================================================================
   ProxCenter — 防火墙规则编辑器

   一条 PVE 规则的可选字段不少，但日常只用到「方向 + 动作 + 协议 + 端口」。
   所以这里默认只展开常用字段，其余（源/目标/宏/网卡/日志/位置）折在「更多」里，
   避免一屏二十个输入框把新手劝退。
   ========================================================================== */

import { useEffect, useMemo, useState } from 'react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { Field, Input, Select, Switch } from './ui/Input';
import { Notice } from './ui/EmptyState';
import { IconShield } from './Icons';
import type { FirewallRefs, FirewallRule, FirewallRuleInput } from '../api/types';

const PROTOCOLS = [
  { label: '任意协议', value: '' },
  { label: 'TCP', value: 'tcp' },
  { label: 'UDP', value: 'udp' },
  { label: 'ICMP', value: 'icmp' },
  { label: 'IPv6-ICMP', value: 'ipv6-icmp' },
  { label: 'IGMP', value: 'igmp' },
  { label: 'ESP', value: 'esp' },
  { label: 'AH', value: 'ah' },
  { label: 'GRE', value: 'gre' },
  { label: 'SCTP', value: 'sctp' },
];

const ACTIONS = [
  { label: 'ACCEPT（放行）', value: 'ACCEPT' },
  { label: 'DROP（丢弃，不回应）', value: 'DROP' },
  { label: 'REJECT（拒绝，回 RST/ICMP）', value: 'REJECT' },
];

const LOG_LEVELS = [
  { label: '不记录', value: 'nolog' },
  { label: 'info', value: 'info' },
  { label: 'notice', value: 'notice' },
  { label: 'warning', value: 'warning' },
  { label: 'err', value: 'err' },
  { label: 'crit', value: 'crit' },
  { label: 'debug', value: 'debug' },
];

const PORT_RE = /^\d+(?::\d+)?(?:,\d+(?::\d+)?)*$/;

function emptyRule(): FirewallRuleInput {
  return {
    type: 'in',
    action: 'ACCEPT',
    enable: true,
    proto: 'tcp',
    dport: '',
    sport: '',
    source: '',
    dest: '',
    macro: '',
    iface: '',
    log: 'nolog',
    comment: '',
    group: '',
    pos: null,
  };
}

export interface FirewallRuleEditorProps {
  open: boolean;
  /** 编辑已有规则时传入；新增时为 null */
  initial?: FirewallRule | null;
  /** 在安全组里编辑：隐藏「网卡」这类只在主机上才有意义的字段 */
  inGroup?: boolean;
  refs?: FirewallRefs;
  busy?: boolean;
  onClose: () => void;
  onSubmit: (rule: FirewallRuleInput) => void;
}

export function FirewallRuleEditor({
  open,
  initial,
  inGroup = false,
  refs,
  busy = false,
  onClose,
  onSubmit,
}: FirewallRuleEditorProps) {
  const [rule, setRule] = useState<FirewallRuleInput>(emptyRule);
  const [showMore, setShowMore] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!open) return;
    setError(undefined);
    if (initial) {
      const { pos, digest: _digest, ...rest } = initial;
      setRule({ ...rest, pos: null });
      setShowMore(
        Boolean(
          initial.source ||
            initial.dest ||
            initial.macro ||
            initial.iface ||
            initial.sport ||
            initial.log !== 'nolog',
        ),
      );
    } else {
      setRule(emptyRule());
      setShowMore(false);
    }
  }, [open, initial]);

  const patch = (part: Partial<FirewallRuleInput>) =>
    setRule((prev) => ({ ...prev, ...part }));

  const groupOptions = useMemo(
    () => [
      { label: '请选择安全组', value: '' },
      ...((refs?.groups ?? []).map((g) => ({ label: g, value: g })) as {
        label: string;
        value: string;
      }[]),
    ],
    [refs?.groups],
  );

  const submit = () => {
    if (rule.type === 'group') {
      if (!rule.group) {
        setError('引用安全组时必须选择一个安全组');
        return;
      }
    } else if (rule.dport && !PORT_RE.test(rule.dport.trim())) {
      setError('端口写法：22 或 80,443 或 8000:8100');
      return;
    }
    if (rule.sport && !PORT_RE.test(rule.sport.trim())) {
      setError('源端口写法：22 或 8000:8100');
      return;
    }
    onSubmit({
      ...rule,
      dport: rule.dport.trim(),
      sport: rule.sport.trim(),
      source: rule.source.trim(),
      dest: rule.dest.trim(),
      iface: rule.iface.trim(),
      comment: rule.comment.trim(),
      pos:
        rule.pos === null || rule.pos === undefined || Number.isNaN(rule.pos as number)
          ? null
          : Number(rule.pos),
    });
  };

  const isGroupRef = rule.type === 'group';
  const useMacro = !isGroupRef && Boolean(rule.macro);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={initial ? `编辑规则 #${initial.pos}` : '新增防火墙规则'}
      description="防火墙按顺序从上到下匹配，命中第一条后不再继续。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} loading={busy}>
            {initial ? '保存' : '添加'}
          </Button>
        </>
      }
    >
      <div className="dyn-list">
        {error ? (
          <Notice tone="danger" title="还没法提交">
            {error}
          </Notice>
        ) : null}

        <div className="field-row">
          <Field label="方向" required>
            <Select
              value={rule.type}
              onChange={(e) => patch({ type: e.target.value })}
              options={[
                { label: '入站（in）', value: 'in' },
                { label: '出站（out）', value: 'out' },
                { label: '引用安全组', value: 'group' },
              ]}
            />
          </Field>
          <Field label="动作" required>
            <Select
              value={rule.action}
              onChange={(e) => patch({ action: e.target.value })}
              options={ACTIONS}
            />
          </Field>
        </div>

        {isGroupRef ? (
          <Field label="安全组" required hint="安全组是集群级的规则集合，可在「安全组」页维护">
            <Select
              value={rule.group}
              onChange={(e) => patch({ group: e.target.value })}
              options={groupOptions}
            />
          </Field>
        ) : (
          <>
            <div className="field-row">
              <Field label="协议">
                <Select
                  value={rule.proto}
                  onChange={(e) => patch({ proto: e.target.value })}
                  options={PROTOCOLS}
                  disabled={useMacro}
                />
              </Field>
              <Field label="端口" hint="留空 = 任意；可写 22、80,443、8000:8100">
                <Input
                  value={rule.dport}
                  onChange={(e) => patch({ dport: e.target.value })}
                  placeholder="22"
                  disabled={useMacro}
                  mono
                />
              </Field>
            </div>

            <Field
              label="宏（可选）"
              hint="PVE 预置的服务组合，如 SSH / HTTP；填了就忽略协议与端口"
            >
              <Input
                value={rule.macro}
                onChange={(e) => patch({ macro: e.target.value })}
                placeholder="SSH"
                mono
                list="fw-macro-suggestions"
              />
            </Field>
            {/* 宏清单随 PVE 版本变化，拿不到就给纯手填；这里只做「下拉建议」 */}
            <datalist id="fw-macro-suggestions">
              {(refs?.macros ?? []).map((macro) => (
                <option key={macro} value={macro} />
              ))}
            </datalist>
          </>
        )}

        <Field label="备注" hint="例如「运维 SSH」「放行内网监控」">
          <Input
            value={rule.comment}
            onChange={(e) => patch({ comment: e.target.value })}
            placeholder="这条规则是做什么的"
            maxLength={120}
          />
        </Field>

        <div className="form-row" style={{ alignItems: 'center' }}>
          <Switch
            checked={rule.enable}
            onChange={(v) => patch({ enable: v })}
            label="启用该规则"
          />
          <Button variant="ghost" size="sm" onClick={() => setShowMore((v) => !v)}>
            {showMore ? '收起高级选项' : '高级选项'}
          </Button>
        </div>

        {showMore ? (
          <>
            <div className="field-row">
              <Field label="来源" hint="IP / CIDR，或 +集合名">
                <Input
                  value={rule.source}
                  onChange={(e) => patch({ source: e.target.value })}
                  placeholder="10.0.0.0/24 或 +office"
                  mono
                />
              </Field>
              <Field label="目标" hint="IP / CIDR，或 +集合名">
                <Input
                  value={rule.dest}
                  onChange={(e) => patch({ dest: e.target.value })}
                  placeholder="192.168.1.10"
                  mono
                />
              </Field>
            </div>

            <div className="field-row">
              <Field label="源端口">
                <Input
                  value={rule.sport}
                  onChange={(e) => patch({ sport: e.target.value })}
                  placeholder="留空 = 任意"
                  mono
                />
              </Field>
              {inGroup ? null : (
                <Field label="网卡" hint="限定只对某块网卡生效，留空 = 全部">
                  <Input
                    value={rule.iface}
                    onChange={(e) => patch({ iface: e.target.value })}
                    placeholder="net0"
                    mono
                  />
                </Field>
              )}
            </div>

            <div className="field-row">
              <Field label="日志级别" hint="记录到宿主机的内核日志（排查时很有用）">
                <Select
                  value={rule.log}
                  onChange={(e) => patch({ log: e.target.value })}
                  options={LOG_LEVELS}
                />
              </Field>
              {initial ? null : (
                <Field label="插入位置" hint="留空 = 追加到最后（优先级最低）">
                  <Input
                    type="number"
                    min={0}
                    value={rule.pos ?? ''}
                    onChange={(e) =>
                      patch({
                        pos: e.target.value === '' ? null : Number(e.target.value),
                      })
                    }
                    placeholder="自动"
                  />
                </Field>
              )}
            </div>
          </>
        ) : null}

        {isGroupRef ? (
          <Notice tone="info" icon={<IconShield size={14} />}>
            引用安全组后，该组的全部规则都会在这里生效；改安全组会同时影响所有引用它的地方。
          </Notice>
        ) : null}
      </div>
    </Modal>
  );
}
