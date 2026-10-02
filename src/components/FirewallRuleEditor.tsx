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
import { useT, type TFunc } from '../i18n';
import type { FirewallRefs, FirewallRule, FirewallRuleInput } from '../api/types';

/* 下面三组选项含中文标签，因此做成接收 t 的工厂函数：模块级常量会让文案
   停在首次加载时的语言上 */
function protoOptions(t: TFunc) {
  return [
    { label: t('fwRule.protoAny'), value: '' },
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
}

function actionOptions(t: TFunc) {
  return [
    { label: t('fwRule.actAccept'), value: 'ACCEPT' },
    { label: t('fwRule.actDrop'), value: 'DROP' },
    { label: t('fwRule.actReject'), value: 'REJECT' },
  ];
}

function logLevelOptions(t: TFunc) {
  return [
    { label: t('fwRule.logNolog'), value: 'nolog' },
    { label: 'info', value: 'info' },
    { label: 'notice', value: 'notice' },
    { label: 'warning', value: 'warning' },
    { label: 'err', value: 'err' },
    { label: 'crit', value: 'crit' },
    { label: 'debug', value: 'debug' },
  ];
}

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
  const t = useT();
  const protocols = useMemo(() => protoOptions(t), [t]);
  const actions = useMemo(() => actionOptions(t), [t]);
  const logLevels = useMemo(() => logLevelOptions(t), [t]);
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
      { label: t('fwRule.selectGroup'), value: '' },
      ...((refs?.groups ?? []).map((g) => ({ label: g, value: g })) as {
        label: string;
        value: string;
      }[]),
    ],
    [refs?.groups, t],
  );

  const submit = () => {
    if (rule.type === 'group') {
      if (!rule.group) {
        setError(t('fwRule.errGroupRequired'));
        return;
      }
    } else if (rule.dport && !PORT_RE.test(rule.dport.trim())) {
      setError(t('fwRule.errDport'));
      return;
    }
    if (rule.sport && !PORT_RE.test(rule.sport.trim())) {
      setError(t('fwRule.errSport'));
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
      title={
        initial
          ? t('fwRule.editTitle', { pos: initial.pos })
          : t('fwRule.newTitle')
      }
      description={t('fwRule.desc')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={submit} loading={busy}>
            {initial ? t('common.save') : t('fwRule.add')}
          </Button>
        </>
      }
    >
      <div className="dyn-list">
        {error ? (
          <Notice tone="danger" title={t('fwRule.cannotSubmit')}>
            {error}
          </Notice>
        ) : null}

        <div className="field-row">
          <Field label={t('fwRule.fieldDir')} required>
            <Select
              value={rule.type}
              onChange={(e) => patch({ type: e.target.value })}
              options={[
                { label: t('fwRule.dirIn'), value: 'in' },
                { label: t('fwRule.dirOut'), value: 'out' },
                { label: t('fwRule.dirGroup'), value: 'group' },
              ]}
            />
          </Field>
          <Field label={t('fwRule.fieldAction')} required>
            <Select
              value={rule.action}
              onChange={(e) => patch({ action: e.target.value })}
              options={actions}
            />
          </Field>
        </div>

        {isGroupRef ? (
          <Field
            label={t('fwRule.fieldGroup')}
            required
            hint={t('fwRule.groupHint')}
          >
            <Select
              value={rule.group}
              onChange={(e) => patch({ group: e.target.value })}
              options={groupOptions}
            />
          </Field>
        ) : (
          <>
            <div className="field-row">
              <Field label={t('fwRule.fieldProto')}>
                <Select
                  value={rule.proto}
                  onChange={(e) => patch({ proto: e.target.value })}
                  options={protocols}
                  disabled={useMacro}
                />
              </Field>
              <Field label={t('fwRule.fieldDport')} hint={t('fwRule.dportHint')}>
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
              label={t('fwRule.fieldMacro')}
              hint={t('fwRule.macroHint')}
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

        <Field label={t('fwRule.fieldComment')} hint={t('fwRule.commentHint')}>
          <Input
            value={rule.comment}
            onChange={(e) => patch({ comment: e.target.value })}
            placeholder={t('fwRule.commentPlaceholder')}
            maxLength={120}
          />
        </Field>

        <div className="form-row" style={{ alignItems: 'center' }}>
          <Switch
            checked={rule.enable}
            onChange={(v) => patch({ enable: v })}
            label={t('fwRule.enable')}
          />
          <Button variant="ghost" size="sm" onClick={() => setShowMore((v) => !v)}>
            {showMore ? t('fwRule.hideAdvanced') : t('fwRule.advanced')}
          </Button>
        </div>

        {showMore ? (
          <>
            <div className="field-row">
              <Field label={t('fwRule.fieldSource')} hint={t('fwRule.sourceHint')}>
                <Input
                  value={rule.source}
                  onChange={(e) => patch({ source: e.target.value })}
                  placeholder={t('fwRule.sourcePlaceholder')}
                  mono
                />
              </Field>
              <Field label={t('fwRule.fieldDest')} hint={t('fwRule.destHint')}>
                <Input
                  value={rule.dest}
                  onChange={(e) => patch({ dest: e.target.value })}
                  placeholder="192.168.1.10"
                  mono
                />
              </Field>
            </div>

            <div className="field-row">
              <Field label={t('fwRule.fieldSport')}>
                <Input
                  value={rule.sport}
                  onChange={(e) => patch({ sport: e.target.value })}
                  placeholder={t('fwRule.anyHint')}
                  mono
                />
              </Field>
              {inGroup ? null : (
                <Field label={t('fwRule.fieldIface')} hint={t('fwRule.ifaceHint')}>
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
              <Field label={t('fwRule.fieldLog')} hint={t('fwRule.logHint')}>
                <Select
                  value={rule.log}
                  onChange={(e) => patch({ log: e.target.value })}
                  options={logLevels}
                />
              </Field>
              {initial ? null : (
                <Field label={t('fwRule.fieldPos')} hint={t('fwRule.posHint')}>
                  <Input
                    type="number"
                    min={0}
                    value={rule.pos ?? ''}
                    onChange={(e) =>
                      patch({
                        pos: e.target.value === '' ? null : Number(e.target.value),
                      })
                    }
                    placeholder={t('fwRule.auto')}
                  />
                </Field>
              )}
            </div>
          </>
        ) : null}

        {isGroupRef ? (
          <Notice tone="info" icon={<IconShield size={14} />}>
            {t('fwRule.groupNote')}
          </Notice>
        ) : null}
      </div>
    </Modal>
  );
}
