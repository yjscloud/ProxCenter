/* ==========================================================================
   ProxCenter — 指派归属弹窗（虚拟机 / 容器共用）

   为什么抽出来：虚拟机详情页与容器详情页都要这一件事，各写一份的结果是两边
   迟早不一致（此前容器详情页干脆没有这个入口，列表里有、点进去没有）。归属
   这套逻辑里「读失败不许保存」「没动过下拉不算清除」这两条都不是显眼的，
   复制一份几乎注定只改一边。

   调用方只负责：给一台 guest（node / vmid / type / connection_id）、给它一个
   展示名和「虚拟机 / 容器」这个名词，剩下的读写与提示都在这里。
   ========================================================================== */

import { useEffect, useState } from 'react';
import { errorMessage } from '../api/client';
import { guestsApi, type GuestRef } from '../api/guests';
import { useToast } from '../hooks/useToast';
import { useT } from '../i18n';
import { Button } from './ui/Button';
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
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 读失败时禁止保存：见 submit 里的说明 */
  const [loadError, setLoadError] = useState('');
  /** 是否动过下拉 —— 「清除」与「还没选」的唯一区别 */
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!guest) return;
    setBusy(false);
    setTouched(false);
    setLoadError('');
    setLoading(true);
    guestsApi
      .getOwner(guest, guest.connection_id ?? undefined)
      .then((res) => setOwner(res.owner ?? ''))
      .catch((err) => {
        setOwner('');
        setLoadError(errorMessage(err));
      })
      .finally(() => setLoading(false));
  }, [guest?.node, guest?.vmid, guest?.type]);

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
    if (!owner.trim() && !touched) {
      toast.error(t('guestList.assignPickFirst'));
      return;
    }
    setBusy(true);
    try {
      const res = await guestsApi.assignOwner(
        guest,
        owner.trim() || null,
        guest.connection_id ?? undefined,
      );
      toast.success(
        res.owner ? t('guestList.assignDone', { noun }) : t('guestList.assignCleared'),
        res.owner || label,
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
      size="sm"
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
            {t('common.save')}
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
        }}
        disabled={loading || Boolean(loadError)}
      />
      {loadError ? (
        <Notice tone="danger" title={t('guestList.assignLoadFailed')}>
          {loadError}
        </Notice>
      ) : null}
    </Modal>
  );
}
