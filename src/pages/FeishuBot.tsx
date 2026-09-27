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
      toast.error("操作失败", errText(err));
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
        return "配置已保存，机器人立即生效";
      },
      "保存成功",
    );
  }

  return (
    <PageShell
      title="飞书机器人"
      subtitle="在飞书会话里直接查询与控制虚拟机（列表 / 状态 / 开机 / 关机 / 重启 / 创建）"
      actions={
        <Button variant="primary" icon={<IconSave size={15} />} loading={busy === "save"}
          disabled={!canManage || !form} onClick={() => void save()}>
          保存
        </Button>
      }
    >
      <Card>
        <CardHeader
          title="应用凭据"
          subtitle="飞书开放平台 → 自建应用 → 凭证与基础信息"
          icon={<IconTerminal size={16} />}
        />
        <Notice tone="info" title="需要开启的权限与订阅">
          权限：<span className="mono">im:message</span>（接收）与{" "}
          <span className="mono">im:message:send_as_bot</span>（回复）。 事件订阅：添加{" "}
          <span className="mono">接收消息 im.message.receive_v1</span> 与{" "}
          <span className="mono">卡片回传交互 card.action.trigger</span>，
          并把回调地址填成下方 URL。建议**关闭 Encrypt Key**（加密事件暂不支持）。
        </Notice>
        {form ? (
          <div className="form-grid">
            <Input label="App ID" value={form.app_id} placeholder="cli_xxxxxxxx"
              className="mono" disabled={!canManage}
              onChange={(e) => setForm({ ...form, app_id: e.target.value })} />
            <Input label="App Secret" type="password" value={form.app_secret}
              placeholder={form.app_secret_set ? "已加密保存，留空表示不修改" : "应用凭证里的 App Secret"}
              hint="以密文存储，接口不会回显" autoComplete="new-password" disabled={!canManage}
              onChange={(e) => setForm({ ...form, app_secret: e.target.value })} />
            <Input label="Verification Token" type="password" value={form.verification_token}
              placeholder={form.verification_token_set ? "已保存，留空表示不修改" : "事件订阅页的 Verification Token"}
              hint="用于校验事件来源，强烈建议填写" autoComplete="off" disabled={!canManage}
              onChange={(e) => setForm({ ...form, verification_token: e.target.value })} />
            <Input label="Encrypt Key（建议留空）" value={form.encrypt_key}
              placeholder={form.encrypt_key_set ? "已保存，留空表示不修改" : "留空即可，加密事件暂不支持解密"}
              hint="填了 Encrypt Key 后飞书会加密事件体，本版本无法解密" disabled={!canManage}
              onChange={(e) => setForm({ ...form, encrypt_key: e.target.value })} />
          </div>
        ) : (
          <div className="skeleton skeleton-text" />
        )}
      </Card>

      <Card>
        <CardHeader
          title="回调地址与白名单"
          subtitle="只有白名单内的会话 / 用户发出的指令才会被执行"
          icon={<IconAlert size={16} />}
          actions={
            <Button variant="ghost" size="sm" icon={<IconRefresh size={14} />}
              disabled={!query.data?.event_url}
              onClick={() => {
                void navigator.clipboard?.writeText(query.data?.event_url || "");
                toast.success("已复制回调地址", query.data?.event_url);
              }}>
              复制回调地址
            </Button>
          }
        />
        <div className="field">
          <label className="field-label">事件回调地址（填入飞书开放平台）</label>
          <div className="input-wrap">
            <input className="input mono" readOnly value={query.data?.event_url || ""} />
          </div>
          <div className="field-message">
            该地址必须能被飞书公网访问；面板在内网时请通过反向代理或内网穿透暴露。
          </div>
        </div>
        {form ? (
          <div className="form-grid">
            <Textarea label="允许的群会话 ID（每行一个）" rows={4} mono
              value={form.allowed_chat_ids.join("\n")}
              placeholder="oc_xxxxxxxxxxxxxxxx"
              hint="oc_ 开头的群 ID。不确定时先给机器人发一条消息，它会把识别到的 chat_id 直接回给你"
              disabled={!canManage}
              onChange={(e) => setForm({ ...form, allowed_chat_ids: e.target.value.split("\n") })} />
            <Textarea label="允许的用户 open_id（每行一个，选填）" rows={4} mono
              value={form.allowed_user_ids.join("\n")}
              placeholder="ou_xxxxxxxxxxxxxxxx"
              hint="必须是 ou_ 开头、且属于当前应用的 open_id（不是 user_id）。机器人拒绝时会回显你的真实 open_id，复制过来即可"
              disabled={!canManage}
              onChange={(e) => setForm({ ...form, allowed_user_ids: e.target.value.split("\n") })} />
            <div className="field-message">
              两个白名单都为空时机器人拒绝一切指令；两者都填写时需同时匹配（群对且人在名单内）才会执行。
            </div>
            <Input label="默认模板 VMID（创建虚拟机用）" value={form.default_template_vmid}
              placeholder="100" className="mono" disabled={!canManage}
              hint="「创建 <名称>」会以此模板克隆"
              onChange={(e) => setForm({ ...form, default_template_vmid: e.target.value })} />
            <Input label="默认目标节点（选填）" value={form.default_node} placeholder="pve"
              className="mono" disabled={!canManage}
              onChange={(e) => setForm({ ...form, default_node: e.target.value })} />
            <Input label="默认目标存储（选填）" value={form.default_storage} placeholder="local-lvm"
              className="mono" disabled={!canManage}
              onChange={(e) => setForm({ ...form, default_storage: e.target.value })} />
            <Input label="默认备份存储（备份指令用）" value={form.default_backup_storage} placeholder="local"
              className="mono" disabled={!canManage}
              hint="发送「备份 105」时写入该存储"
              onChange={(e) => setForm({ ...form, default_backup_storage: e.target.value })} />
          </div>
        ) : null}
      </Card>

      {form ? null : <div className="skeleton skeleton-text" />}
      <Card>
        <CardHeader
          title="机器人状态"
          subtitle="需要在飞书开放平台创建自建应用，并订阅回调地址"
          icon={<IconTerminal size={16} />}
          actions={
            <Badge variant={form?.enabled ? "success" : "neutral"} size="sm" dot>
              {form?.enabled ? "已启用" : "已关闭"}
            </Badge>
          }
        />
        {form ? (
          <div className="form-grid">
            <div className="field">
              <Switch checked={form.enabled} label="启用机器人"
                hint="关闭后飞书消息一律忽略（回调仍可访问）"
                onChange={(v) => setForm({ ...form, enabled: v })} />
            </div>
            <div className="field">
              <Switch checked={form.allow_write} label="允许写操作"
                hint="关闭后只能查询列表与状态"
                onChange={(v) => setForm({ ...form, allow_write: v })} />
            </div>
            <div className="field">
              <Switch checked={form.allow_create} label="允许创建虚拟机"
                hint="允许用默认模板克隆新虚拟机"
                onChange={(v) => setForm({ ...form, allow_create: v })} />
            </div>
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader title="发送测试" subtitle="向指定会话推送一张卡片，验证凭据是否正确"
          icon={<IconTerminal size={16} />} />
        <div className="flex items-center gap-8">
          <Input value={testChat} placeholder="群会话 ID，oc_ 开头"
            className="mono" disabled={!canManage}
            onChange={(e) => setTestChat(e.target.value)} />
          <Button variant="secondary" loading={busy === "test"} disabled={!canManage || !testChat}
            onClick={() =>
              void run("test", async () => (await feishuApi.test(testChat.trim())).detail, "已发送")
            }>
            发送测试
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader title="可用指令" subtitle="在飞书里 @机器人 或私聊发送即可"
          icon={<IconTerminal size={16} />} />
        <div className="table-container">
          <table className="table table-dense">
            <thead>
              <tr>
                <th>指令</th>
                <th>说明</th>
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
          关机 / 重启 / 创建属于危险操作，机器人会先回一张确认卡片，点击「确认执行」才会真正下发。
        </div>
      </Card>
    </PageShell>
  );
}
