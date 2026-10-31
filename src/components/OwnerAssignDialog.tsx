/* ==========================================================================
   ProxCenter — 指派归属弹窗（虚拟机 / 容器共用）

   为什么抽出来：虚拟机详情页与容器详情页都要这一件事，各写一份的结果是两边
   迟早不一致（此前容器详情页干脆没有这个入口，列表里有、点进去没有）。归属
   这套逻辑里「读失败不许保存」「没动过下拉不算清除」这两条都不是显眼的，
   复制一份几乎注定只改一边。

   调用方只负责：给一台 guest（node / vmid / type / connection_id）、给它一个
   展示名和「虚拟机 / 容器」这个名词，剩下的读写与提示都在这里。

   两件容易被忽略的事，在这里集中处理：

   1. **改派是有连带效果的**（快照归属、活动告警收件人、穿透规则失效），
      而「宿主机上的 SSH / 基线 / 端口数据不会跟过来」同样重要。所以弹窗里
      固定列出「会跟随 / 不会跟随」，不靠操作者自己记得。
   2. **从别人名下改派要确认两次**：覆盖式写入之后没有「撤销」，而 `previous`
      只在这一次响应里出现，误操作无法回头。
   ========================================================================== */

import { useEffect, useState } from 'react';
import { errorMessage } from '../api/client';
import { guestsApi, type GuestRef } from '../api/guests';
import { useToast } from '../hooks/useToast';
import { useT } from '../i18n';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Modal } from './ui/Modal';
import { Notice } from './ui/EmptyState';
import { UserSelect } from './ui/UserSelect';

export interface OwnerAssignDialogProps {
  /** 目标 guest；null = 关闭。type 必须带上：容器漏传会落进 vm 桶（见 guests.ts） */
  guest: GuestRef | null;
  /** 展示名（成功提示用），一般取 name，没有就用 vmid */
  label: string;
  /** 「虚拟机」/「容器」——标题与说明里的名词 */
  noun: string;
  onClose: () => void;
  onDone: () => void;
}

export function OwnerAssignDialog({
  guest,
  label,
  noun,
  onClose,
  onDone,
}: OwnerAssignDialogProps) {
  const t = useT();
  const toast = useToast();
  const [owner, setOwner] = useState('');
  /** 读到的当前归属：既做「原归 xxx」提示，也是「这是改派」的判定依据 */
  const [previous, setPrevious] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 读失败时禁止保存：见 submit 里的说明 */
  const [loadError, setLoadError] = useState('');
  /** 是否动过下拉 —— 「清除」与「还没选」的唯一区别 */
  const [touched, setTouched] = useState(false);
  /** 改派的二次确认：第一次点只是把按钮换成「确认改派」 */
  const [confirming, setConfirming] = useState(false);
  /** 变更理由 / 工单号：只进审计。改派是覆盖式写入，事后只有它答得了「为什么改」 */
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!guest) return;
    setBusy(false);
    setTouched(false);
    setConfirming(false);
    setReason('');
    setLoadError('');
    setLoading(true);
    guestsApi
      .getOwner(guest, guest.connection_id ?? undefined)
      .then((res) => {
        const current = res.owner ?? '';
        setOwner(current);
        setPrevious(current);
      })
      .catch((err) => {
        setOwner('');
        setPrevious('');
        setLoadError(errorMessage(err));
      })
      .finally(() => setLoading(false));
    /* connection_id 也要进依赖：VMID 只在**同一个集群内**唯一，两套 PVE 上各有一台
       100 号机器时，只按 node/vmid/type 判断就会沿用上一个连接读到的归属 ——
       弹窗里显示的「当前归属」是别人的账，改派可能直接覆盖掉真正的主人。 */
  }, [guest?.node, guest?.vmid, guest?.type, guest?.connection_id]);

  const nextOwner = owner.trim();
  /** 从某个人名下转到另一个人名下 —— 只有这种情况才需要二次确认 */
  const isTransfer = Boolean(previous) && Boolean(nextOwner) && nextOwner !== previous;

  const submit = async () => {
    if (!guest || loading) return;
    if (loadError) {
      /* 读失败还让他保存，等于用「空」覆盖掉真实的归属 —— 这是最坏的一种
         静默数据丢失，所以这里直接拦下 */
      toast.error(t('guestList.assignLoadFailed'), loadError);
      return;
    }
    /* 空值 = 清除归属。没动过下拉时空值只说明「还没选人」，不能当成清除 ——
       否则在输完用户名直接点保存（点外面会收起并丢掉搜索词）时，
       一次保存就把归属抹了，而且全程不报错。 */
    if (!nextOwner && !touched) {
      toast.error(t('guestList.assignPickFirst'));
      return;
    }
    /* 改派先落到确认态：覆盖式写入没有撤销，而 previous 只在这次响应里出现 */
    if (isTransfer && !confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    try {
      const res = await guestsApi.assignOwner(
        guest,
        nextOwner || null,
        guest.connection_id ?? undefined,
        reason.trim() || undefined,
      );
      /* 结果里带上这次连带处理了什么：快照标记清了几条、活动告警搬了几条、
         穿透规则失效了几条。管理员需要知道改派不是「只改一个名字」 */
      const notes: string[] = [];
      if (res.previous && res.previous !== (res.owner ?? '')) {
        notes.push(t('guestList.assignPrevOwner', { name: res.previous }));
      }
      if (res.snapshots_removed) {
        notes.push(t('guestList.assignSnapshotsMoved', { n: res.snapshots_removed }));
      }
      if (res.active_alerts_moved) {
        notes.push(t('guestList.assignAlertsMoved', { n: res.active_alerts_moved }));
      }
      if (res.frp_rules_suspended) {
        notes.push(t('guestList.assignFrpSuspended', { n: res.frp_rules_suspended }));
      }
      toast.success(
        res.owner ? t('guestList.assignDone', { noun }) : t('guestList.assignCleared'),
        notes.length ? notes.join(' · ') : res.owner || label,
      );
      onDone();
    } catch (err) {
      toast.error(t('guestList.assignFailed'), errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(guest)}
      onClose={busy ? () => undefined : onClose}
      title={t('guestList.assignTitle', { noun })}
      description={t('guestList.assignDesc', { noun })}
      size="md"
      closeOnOverlay={!busy}
      hideClose={busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={busy}
            disabled={loading || Boolean(loadError)}
          >
            {isTransfer
              ? confirming
                ? t('guestList.assignTransferConfirm', { to: nextOwner })
                : t('guestList.assignTransferStart', { to: nextOwner })
              : t('common.save')}
          </Button>
        </>
      }
    >
      <UserSelect
        label={t('guestList.assignField')}
        hint={
          loading
            ? t('guestList.assignLoading')
            : owner.trim()
              ? t('guestList.assignCurrent', { name: owner.trim() })
              : undefined
        }
        /* 空项的含义要说清：它不是「不填」，而是「让这台机器变回无人认领」 */
        emptyLabel={t('guestList.assignEmpty')}
        value={owner}
        onChange={(next) => {
          setOwner(next);
          setTouched(true);
          setConfirming(false);
        }}
        disabled={loading || Boolean(loadError)}
      />

      {/* 理由不是必填，但它填的是「为什么改」——审计里除了 previous 之外唯一的人话 */}
      <Input
        label={t('guestList.assignReason')}
        hint={t('guestList.assignReasonHint')}
        placeholder={t('guestList.assignReasonPlaceholder')}
        value={reason}
        maxLength={120}
        onChange={(e) => setReason(e.target.value)}
        disabled={loading || Boolean(loadError)}
      />

      {isTransfer ? (
        <Notice
          tone={confirming ? 'danger' : 'warning'}
          title={t('guestList.assignTransferTitle', { from: previous, to: nextOwner })}
        >
          {confirming
            ? t('guestList.assignTransferArmed', { from: previous, to: nextOwner, noun })
            : t('guestList.assignTransferBody', { from: previous, to: nextOwner, noun })}
        </Notice>
      ) : null}

      {/* 「会跟随 / 不会跟随」固定展示：这是唯一能让人在点确认之前知道
          宿主机上的安全数据不会跟过来的地方。

          两列**结构必须一致**（每条 = 一行主文 + 一行注），否则短的那列底下会留
          一大片空白，看起来像内容没加载出来；长的那列也会显得被挤压。 */}
      <div className="assign-scope">
        <div className="assign-scope-col">
          <span className="assign-scope-title assign-scope-follow">
            {t('guestList.assignScopeFollowTitle')}
          </span>
          <ul className="assign-scope-list">
            <li>
              {t('guestList.assignScopeFollowAccess')}
              <span className="assign-scope-note">
                {t('guestList.assignScopeFollowAccessNote')}
              </span>
            </li>
            <li>
              {t('guestList.assignScopeFollowQuota')}
              <span className="assign-scope-note">
                {t('guestList.assignScopeFollowQuotaNote')}
              </span>
            </li>
            <li>
              {t('guestList.assignScopeFollowAlerts')}
              <span className="assign-scope-note">
                {t('guestList.assignScopeFollowAlertsNote')}
              </span>
            </li>
            <li>
              {t('guestList.assignScopeFollowSnapshots')}
              <span className="assign-scope-note">
                {t('guestList.assignScopeFollowSnapshotsNote')}
              </span>
            </li>
            <li>
              {t('guestList.assignScopeFollowFrp')}
              <span className="assign-scope-note">
                {t('guestList.assignScopeFollowFrpNote')}
              </span>
            </li>
          </ul>
        </div>
        <div className="assign-scope-col">
          <span className="assign-scope-title assign-scope-keep">
            {t('guestList.assignScopeKeepTitle')}
          </span>
          {/* 每条都带「要跟随怎么操作」：只写「不会跟」而没有下一步，等于把问题
              丢回给操作者 —— 尤其宿主机那条，它确实能跟，只是要单独改一次主机归属 */}
          <ul className="assign-scope-list">
            <li>
              {t('guestList.assignScopeKeepAudit')}
              <span className="assign-scope-note">
                {t('guestList.assignScopeKeepAuditHow')}
              </span>
            </li>
            <li>
              {t('guestList.assignScopeKeepHost')}
              <span className="assign-scope-note">
                {t('guestList.assignScopeKeepHostHow')}
              </span>
            </li>
            <li>
              {t('guestList.assignScopeKeepLogin')}
              <span className="assign-scope-note">
                {t('guestList.assignScopeKeepLoginHow')}
              </span>
            </li>
            <li>
              {t('guestList.assignScopeKeepCreds')}
              <span className="assign-scope-note">
                {t('guestList.assignScopeKeepCredsHow')}
              </span>
            </li>
          </ul>
        </div>
      </div>

      {loadError ? (
        <Notice tone="danger" title={t('guestList.assignLoadFailed')}>
          {loadError}
        </Notice>
      ) : null}
    </Modal>
  );
}
