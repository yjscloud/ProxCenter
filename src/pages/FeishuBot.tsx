/* ==========================================================================
   ProxCenter — 飞书机器人（在飞书里控制虚拟机）
   ========================================================================== */

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { feishuApi } from "../api/endpoints";
import { PageShell } from "../components/Layout";
import { Card, CardHeader } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Input, Switch, Textarea } from "../components/ui/Input";
import { Notice } from "../components/ui/EmptyState";
import { IconTerminal, IconSave, IconRefresh, IconAlert } from "../components/Icons";
import { useToast } from "../hooks/useToast";
import { useAuth } from "../hooks/useAuth";
import { useT } from "../i18n";
import type { BotConfig } from "../api/types";

function errText(err: unknown): string {
  const detail = (err as any)?.response?.data?.detail;
  if (typeof detail === "string" && detail) return detail;
  return err instanceof Error ? err.message : String(err);
}

const EMPTY: BotConfig = {
  enabled: false,
  app_id: "",
  app_secret: "",
  verification_token: "",
  encrypt_key: "",
  allowed_chat_ids: [],
  allowed_user_ids: [],
  allow_write: true,
  allow_create: true,
  default_template_vmid: "",
  default_node: "",
  default_storage: "",
  default_backup_storage: "",
  max_vms: 20,
};

export function FeishuBot() {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  // 机器人是全局单例：这一页只对管理员开放（接口同样要求管理员）
  const { isAdmin } = useAuth();
  const canManage = isAdmin;

  const [form, setForm] = useState<BotConfig | null>(null);
  const [busy, setBusy] = useState("");
  const [testChat, setTestChat] = useState("");

  const query = useQuery({ queryKey: ["feishu", "bot"], queryFn: feishuApi.get, retry: false });

  useEffect(() => {
    if (query.data?.config && form === null) setForm({ ...EMPTY, ...query.data.config });
  }, [query.data, form]);

  async function run(key: string, fn: () => Promise<string>, title: string) {
    setBusy(key);
    try {
      const note = await fn();
      await qc.invalidateQueries({ queryKey: ["feishu", "bot"] });
      toast.success(title, note || undefined);
      return true;
    } catch (err) {
      toast.error(t('common.opFailed'), errText(err));
      return false;
    } finally {
      setBusy("");
    }
  }

  async function save() {
    if (!form) return;
    await run(
      "save",
      async () => {
        await feishuApi.save({
          ...form,
          allowed_chat_ids: form.allowed_chat_ids.join("\n"),
          allowed_user_ids: form.allowed_user_ids.join("\n"),
        });
        return t('feishu.saveOkDetail');
      },
      t('feishu.saveOk'),
    );
  }

  return (
    <PageShell
      title={t('feishu.title')}
      subtitle={t('feishu.subtitle')}
      actions={
        <Button variant="primary" icon={<IconSave size={15} />} loading={busy === "save"}
          disabled={!canManage || !form} onClick={() => void save()}>
          {t('common.save')}
        </Button>
      }
    >
      <Card>
        <CardHeader
          title={t('feishu.credentialsTitle')}
          subtitle={t('feishu.credentialsSubtitle')}
          icon={<IconTerminal size={16} />}
        />
        <Notice tone="info" title={t('feishu.permTitle')}>
          {t('feishu.permScopes')} <span className="mono">im:message</span>{" "}
          {t('feishu.permReceive')}{" "}
          <span className="mono">im:message:send_as_bot</span> {t('feishu.permReply')}{" "}
          <span className="mono">{t('feishu.permEvtMessage')}</span> {t('feishu.permAnd')}{" "}
          <span className="mono">{t('feishu.permEvtCard')}</span>
          {t('feishu.permTail')}
        </Notice>
        {form ? (
          <div className="form-grid">
            <Input label={t('feishu.appIdLabel')} value={form.app_id} placeholder="cli_xxxxxxxx"
              className="mono" disabled={!canManage}
              onChange={(e) => setForm({ ...form, app_id: e.target.value })} />
            <Input label={t('feishu.appSecretLabel')} type="password" value={form.app_secret}
              placeholder={form.app_secret_set ? t('feishu.appSecretPlaceholderSet') : t('feishu.appSecretPlaceholder')}
              hint={t('feishu.appSecretHint')} autoComplete="new-password" disabled={!canManage}
              onChange={(e) => setForm({ ...form, app_secret: e.target.value })} />
            <Input label={t('feishu.verifyTokenLabel')} type="password" value={form.verification_token}
              placeholder={form.verification_token_set ? t('feishu.verifyTokenPlaceholderSet') : t('feishu.verifyTokenPlaceholder')}
              hint={t('feishu.verifyTokenHint')} autoComplete="off" disabled={!canManage}
              onChange={(e) => setForm({ ...form, verification_token: e.target.value })} />
            <Input label={t('feishu.encryptKeyLabel')} value={form.encrypt_key}
              placeholder={form.encrypt_key_set ? t('feishu.encryptKeyPlaceholderSet') : t('feishu.encryptKeyPlaceholder')}
              hint={t('feishu.encryptKeyHint')} disabled={!canManage}
              onChange={(e) => setForm({ ...form, encrypt_key: e.target.value })} />
          </div>
        ) : (
          <div className="skeleton skeleton-text" />
        )}
      </Card>

      <Card>
        <CardHeader
          title={t('feishu.callbackTitle')}
          subtitle={t('feishu.callbackSubtitle')}
          icon={<IconAlert size={16} />}
          actions={
            <Button variant="ghost" size="sm" icon={<IconRefresh size={14} />}
              disabled={!query.data?.event_url}
              onClick={() => {
                void navigator.clipboard?.writeText(query.data?.event_url || "");
                toast.success(t('feishu.copyCallbackOk'), query.data?.event_url);
              }}>
              {t('feishu.copyCallback')}
            </Button>
          }
        />
        <div className="field">
          <label className="field-label">{t('feishu.callbackLabel')}</label>
          <div className="input-wrap">
            <input className="input mono" readOnly value={query.data?.event_url || ""} />
          </div>
          <div className="field-message">
            {t('feishu.callbackHint')}
          </div>
        </div>
        {form ? (
          <div className="form-grid">
            <Textarea label={t('feishu.chatIdsLabel')} rows={4} mono
              value={form.allowed_chat_ids.join("\n")}
              placeholder={t('feishu.chatIdsPlaceholder')}
              hint={t('feishu.chatIdsHint')}
              disabled={!canManage}
              onChange={(e) => setForm({ ...form, allowed_chat_ids: e.target.value.split("\n") })} />
            <Textarea label={t('feishu.userIdsLabel')} rows={4} mono
              value={form.allowed_user_ids.join("\n")}
              placeholder={t('feishu.userIdsPlaceholder')}
              hint={t('feishu.userIdsHint')}
              disabled={!canManage}
              onChange={(e) => setForm({ ...form, allowed_user_ids: e.target.value.split("\n") })} />
            <div className="field-message">
              {t('feishu.allowlistEmptyHint')}
            </div>
            <Input label={t('feishu.templateVmidLabel')} value={form.default_template_vmid}
              placeholder="100" className="mono" disabled={!canManage}
              hint={t('feishu.templateVmidHint')}
              onChange={(e) => setForm({ ...form, default_template_vmid: e.target.value })} />
            <Input label={t('feishu.defaultNodeLabel')} value={form.default_node} placeholder="pve"
              className="mono" disabled={!canManage}
              onChange={(e) => setForm({ ...form, default_node: e.target.value })} />
            <Input label={t('feishu.defaultStorageLabel')} value={form.default_storage} placeholder="local-lvm"
              className="mono" disabled={!canManage}
              onChange={(e) => setForm({ ...form, default_storage: e.target.value })} />
            <Input label={t('feishu.defaultBackupStorageLabel')} value={form.default_backup_storage} placeholder="local"
              className="mono" disabled={!canManage}
              hint={t('feishu.defaultBackupStorageHint')}
              onChange={(e) => setForm({ ...form, default_backup_storage: e.target.value })} />
          </div>
        ) : null}
      </Card>

      {form ? null : <div className="skeleton skeleton-text" />}
      <Card>
        <CardHeader
          title={t('feishu.statusTitle')}
          subtitle={t('feishu.statusSubtitle')}
          icon={<IconTerminal size={16} />}
          actions={
            <Badge variant={form?.enabled ? "success" : "neutral"} size="sm" dot>
              {form?.enabled ? t('feishu.statusEnabled') : t('feishu.statusDisabled')}
            </Badge>
          }
        />
        {form ? (
          <div className="form-grid">
            <div className="field">
              <Switch checked={form.enabled} label={t('feishu.enableLabel')}
                hint={t('feishu.enableHint')}
                onChange={(v) => setForm({ ...form, enabled: v })} />
            </div>
            <div className="field">
              <Switch checked={form.allow_write} label={t('feishu.allowWriteLabel')}
                hint={t('feishu.allowWriteHint')}
                onChange={(v) => setForm({ ...form, allow_write: v })} />
            </div>
            <div className="field">
              <Switch checked={form.allow_create} label={t('feishu.allowCreateLabel')}
                hint={t('feishu.allowCreateHint')}
                onChange={(v) => setForm({ ...form, allow_create: v })} />
            </div>
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader title={t('feishu.testTitle')} subtitle={t('feishu.testSubtitle')}
          icon={<IconTerminal size={16} />} />
        <div className="flex items-center gap-8">
          <Input value={testChat} placeholder={t('feishu.testPlaceholder')}
            className="mono" disabled={!canManage}
            onChange={(e) => setTestChat(e.target.value)} />
          <Button variant="secondary" loading={busy === "test"} disabled={!canManage || !testChat}
            onClick={() =>
              void run("test", async () => (await feishuApi.test(testChat.trim())).detail, t('feishu.testSent'))
            }>
            {t('feishu.testSend')}
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader title={t('feishu.commandsTitle')} subtitle={t('feishu.commandsSubtitle')}
          icon={<IconTerminal size={16} />} />
        <div className="table-container">
          <table className="table table-dense">
            <thead>
              <tr>
                <th>{t('feishu.colCmd')}</th>
                <th>{t('feishu.colDesc')}</th>
              </tr>
            </thead>
            <tbody>
              {(query.data?.commands || []).map((c) => (
                <tr key={c.cmd}>
                  <td className="mono">{c.cmd}</td>
                  <td className="text-secondary">{c.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="field-message">
          {t('feishu.commandsHint')}
        </div>
      </Card>
    </PageShell>
  );
}
