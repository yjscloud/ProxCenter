/* ==========================================================================
   签发渠道

   这里只做两件事：列出已添加的渠道、把「添加 / 编辑」交给弹窗。
   表单本身不在卡片里堆着 —— 和 certd 的「授权管理」一样，厂商列表是入口，
   凭据是弹窗里一次性填完的东西，填完就收起，页面上只留结果与状态。
   ========================================================================== */

import { useMemo, useState } from "react";
import { Button } from "./ui/Button";
import { Card, CardHeader } from "./ui/Card";
import { IconCloud, IconPlus } from "./Icons";
import { CertProviderDialog, type ProviderEditorMode } from "./CertProviderDialog";
import { useT, type MessageKey } from "../i18n";
import type { CertProviderInfo } from "../api/types";

interface Props {
  providers: CertProviderInfo[];
  canManage: boolean;
  /** 页面级忙碌键：``provider:<kind>`` / ``provider-test:<kind>`` */
  busy: string;
  onSave: (kind: string, payload: Record<string, unknown>) => Promise<boolean>;
  onTest: (kind: string) => void;
}

interface Editor {
  mode: ProviderEditorMode;
  kind: string;
}

/** AK ID 之类的标识不是秘密，但也没必要整串铺在列表里 */
function maskId(value: string): string {
  const text = String(value || "");
  if (text.length <= 12) return text;
  return text.slice(0, 6) + "…" + text.slice(-4);
}

export function CertProvidersCard({ providers, canManage, busy, onSave, onTest }: Props) {
  const t = useT();
  const [editor, setEditor] = useState<Editor | null>(null);

  const configured = useMemo(
    () => providers.filter((provider) => provider.configured),
    [providers],
  );
  const pending = useMemo(
    () => providers.filter((provider) => !provider.configured),
    [providers],
  );

  function openAdd() {
    setEditor({ mode: "add", kind: (pending[0] ?? providers[0])?.kind ?? "" });
  }

  return (
    <Card className="cert-card-sub">
      <CardHeader
        title={t("cert.providersTitle")}
        subtitle={
          providers.length > 0 ? (
            <>
              {t("cert.providerSummary", { n: configured.length, total: providers.length })}
              {pending.length > 0 ? (
                <>
                  {" · "}
                  {t("cert.providerPending", {
                    names: pending
                      .map((provider) => t(provider.label_key as MessageKey) || provider.label)
                      .join("、"),
                  })}
                </>
              ) : null}
            </>
          ) : undefined
        }
        icon={<IconCloud size={16} />}
        /* 一条都还没配时，引导框里已经有主按钮了，标题栏不再重复一个 */
        actions={
          configured.length > 0 ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<IconPlus size={14} />}
              disabled={!canManage}
              onClick={openAdd}
            >
              {t("cert.addProvider")}
            </Button>
          ) : undefined
        }
      />

      {configured.length === 0 ? (
        <div className="cert-provider-empty">
          <span className="cert-provider-empty-icon" aria-hidden="true">
            <IconCloud size={18} />
          </span>
          <div className="cert-provider-empty-text">
            <div className="cert-provider-empty-title">{t("cert.providerEmptyTitle")}</div>
            <div className="fs-xs text-muted">{t("cert.providerEmptyDesc")}</div>
          </div>
          <Button
            variant="primary"
            size="sm"
            icon={<IconPlus size={14} />}
            disabled={!canManage}
            onClick={openAdd}
          >
            {t("cert.addProvider")}
          </Button>
        </div>
      ) : (
        <div className="cert-provider-list">
          {configured.map((provider) => {
            const idField = provider.identity_key
              ? provider.fields.find((field) => field.key === provider.identity_key)
              : provider.fields.find((field) => !field.secret && /(^|_)id$/.test(field.key));
            const renew = provider.values?.renew_before_days;
            return (
              <div className="cert-provider-row" key={provider.kind}>
                <span className="cert-provider-name">
                  {t(provider.label_key as MessageKey) || provider.label}
                </span>
                <div className="cert-provider-meta">
                  <span className="cert-provider-id mono fs-xs text-muted">
                    {idField ? maskId(String(provider.values?.[idField.key] ?? "")) : ""}
                  </span>
                  <span className="cert-provider-renew fs-xs text-muted">
                    {renew != null ? t("cert.renewDaysShort", { n: Number(renew) }) : ""}
                  </span>
                  <span className="cert-provider-actions">
                  {provider.test_disabled ? null : (
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={busy === "provider-test:" + provider.kind}
                      disabled={!canManage}
                      onClick={() => onTest(provider.kind)}
                    >
                      {t("cert.testConnection")}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!canManage}
                    onClick={() => setEditor({ mode: "edit", kind: provider.kind })}
                  >
                    {t("common.edit")}
                  </Button>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editor ? (
        <CertProviderDialog
          mode={editor.mode}
          providers={providers}
          initialKind={editor.kind}
          canManage={canManage}
          busy={busy}
          onClose={() => setEditor(null)}
          onTest={onTest}
          onSave={async (kind, payload) => {
            const ok = await onSave(kind, payload);
            if (ok) setEditor(null);
            return ok;
          }}
        />
      ) : null}
    </Card>
  );
}
