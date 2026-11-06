/* ==========================================================================
   添加 / 编辑签发渠道

   流程参照 certd「授权管理 → 添加」：先选厂商类型，再由后端下发的插件 schema
   动态生成凭据表单（字段、默认值、必填项都来自后端）。比它多做了两件事：
     · 厂商选择用带说明的列表，而不是只能输名字的下拉（现在 3 家，将来 10 家也
       不必先记住厂商叫什么）；
     · 保存前做一次本地校验，保存后自动跑一次连接测试，结果用 toast 回执。
   ========================================================================== */

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Input, Select } from "./ui/Input";
import { Modal } from "./ui/Modal";
import { IconCloud, IconKey } from "./Icons";
import { useT, type MessageKey } from "../i18n";
import type { CertProviderInfo } from "../api/types";

export type ProviderEditorMode = "add" | "edit";

interface Props {
  mode: ProviderEditorMode;
  providers: CertProviderInfo[];
  /** 打开时默认选中的厂商（未配置的那家优先） */
  initialKind: string;
  canManage: boolean;
  /** 页面级忙碌键：``provider:<kind>`` / ``provider-test:<kind>`` */
  busy: string;
  onClose: () => void;
  /** 返回 true 表示保存成功（父级据此关闭弹窗） */
  onSave: (kind: string, payload: Record<string, unknown>) => Promise<boolean>;
  onTest: (kind: string) => void;
}

type Values = Record<string, string | number>;
type Errors = Record<string, string>;

export function CertProviderDialog({
  mode,
  providers,
  initialKind,
  canManage,
  busy,
  onClose,
  onSave,
  onTest,
}: Props) {
  const t = useT();
  const initial = providers.find((provider) => provider.kind === initialKind) ?? providers[0];
  const [kind, setKind] = useState<string>(initial?.kind ?? "");
  const [values, setValues] = useState<Values>(initial?.values ?? {});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Errors>({});
  const [attempted, setAttempted] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);

  const active = useMemo(
    () => providers.find((provider) => provider.kind === kind) ?? initial,
    [providers, kind, initial],
  );

  const label = active ? t(active.label_key as MessageKey) || active.label : "";
  const saving = active ? busy === "provider:" + active.kind : false;
  const testing = active ? busy === "provider-test:" + active.kind : false;

  /* 切换厂商 = 换一份 schema：把草稿与错误一起清掉，避免把 A 家的值填进 B 家 */
  useEffect(() => {
    setValues(active?.values ?? {});
    setSecrets({});
    setErrors({});
    setAttempted(false);
  }, [active]);

  if (!active) return null;

  /** 条件字段（如 DNS 凭据）：只在依赖项取到对应值时才出现、才校验 */
  function visibleFields(valuesNow: Values) {
    return active.fields.filter((field) => {
      const rule = field.show_if;
      if (!rule) return true;
      return (rule.in ?? []).includes(String(valuesNow[rule.key] ?? ""));
    });
  }

  /** 校验：必填 + 数字范围。编辑态下「已保存的密文」不作必填（留空 = 不修改）。 */
  function validate(nextValues: Values, nextSecrets: Record<string, string>): Errors {
    const next: Errors = {};
    for (const field of visibleFields(nextValues)) {
      const raw = field.secret ? nextSecrets[field.key] ?? "" : nextValues[field.key];
      const text = String(raw ?? "").trim();
      /* 已保存的密文永远不作必填：留空就是「不改」，与处于添加还是编辑态无关 */
      const required = !!field.required && !(field.secret && active.secret_set?.[field.key]);
      if (required && !text) {
        next[field.key] = t("cert.fieldRequired");
        continue;
      }
      if (field.type === "number" && text !== "") {
        const num = Number(text);
        const min = field.min ?? 0;
        const max = field.max ?? 60;
        if (!Number.isFinite(num) || num < min || num > max) {
          next[field.key] = t("cert.fieldNumberRange", { min, max });
        }
      }
    }
    return next;
  }

  async function submit() {
    setAttempted(true);
    const nextErrors = validate(values, secrets);
    setErrors(nextErrors);
    const firstBad = visibleFields(values).find((field) => nextErrors[field.key]);
    if (firstBad) {
      formRef.current
        ?.querySelector<HTMLElement>(`[data-field="${firstBad.key}"] input, [data-field="${firstBad.key}"] select`)
        ?.focus();
      return;
    }
    const payload: Record<string, unknown> = { ...values };
    for (const field of active.fields) {
      if (field.secret) payload[field.key] = secrets[field.key] ?? "";
    }
    await onSave(active.kind, payload);
  }

  function patchValues(patch: Values) {
    const next = { ...values, ...patch };
    setValues(next);
    if (attempted) setErrors(validate(next, secrets));
  }

  function patchSecrets(patch: Record<string, string>) {
    const next = { ...secrets, ...patch };
    setSecrets(next);
    if (attempted) setErrors(validate(values, next));
  }

  const errorCount = Object.keys(errors).length;

  return (
    <Modal
      open
      onClose={onClose}
      title={mode === "edit" ? t("cert.editProvider") : t("cert.addProvider")}
      description={
        mode === "edit" ? t("cert.providerDialogDescEdit") : t("cert.providerDialogDesc")
      }
      size="lg"
      footer={
        <>
          {active.configured && !active.test_disabled ? (
            <Button
              variant="ghost"
              loading={testing}
              disabled={!canManage}
              onClick={() => onTest(active.kind)}
            >
              {t("cert.testConnection")}
            </Button>
          ) : null}
          <div className="cert-dialog-spacer" />
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={!canManage}
            onClick={() => void submit()}
          >
            {mode === "edit" || active.configured
              ? t("common.save")
              : t("cert.addProviderConfirm")}
          </Button>
        </>
      }
    >
      <div className={`cert-picker ${mode === "edit" ? "is-single" : ""}`}>
        {mode === "add" ? (
          <div className="cert-picker-rail" role="radiogroup" aria-label={t("cert.providerSelect")}>
            {providers.map((provider) => {
              const selected = provider.kind === active.kind;
              return (
                <button
                  key={provider.kind}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`cert-picker-item ${selected ? "is-active" : ""}`}
                  onClick={() => setKind(provider.kind)}
                >
                  <span className="cert-picker-name">
                    <span className="cert-picker-label">
                      <IconCloud size={14} />
                      {t(provider.label_key as MessageKey) || provider.label}
                    </span>
                    {provider.configured ? (
                      <span className="cert-picker-flag">{t("cert.providerAdded")}</span>
                    ) : null}
                  </span>
                  <span className="cert-picker-tagline">
                    {t(provider.tagline_key as MessageKey) || provider.tagline}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}

        <div className="cert-picker-form" ref={formRef}>
          <div className="cert-picker-head">
            <span className="cert-picker-title">
              <IconKey size={14} />
              {label}
            </span>
            <Badge variant={active.configured ? "success" : "neutral"} size="sm">
              {active.configured ? t("cert.providerReady") : t("cert.providerUnset")}
            </Badge>
            {active.help_url ? (
              <a
                className="cert-picker-help"
                href={active.help_url}
                target="_blank"
                rel="noreferrer noopener"
              >
                {t("cert.providerHelp")}
              </a>
            ) : null}
          </div>

          <div className="cert-picker-note">
            {mode === "edit" && active.configured
              ? t("cert.providerEditLocked")
              : active.test_disabled
                ? t("cert.providerAcmeNote")
                : t("cert.providerAddNote")}
          </div>

          <div className="form-grid">
            {visibleFields(values).map((field) => {
              const fieldLabel = t(field.label_key as MessageKey) || field.key;
              const error = errors[field.key];
              const required =
                !!field.required && !(field.secret && active.secret_set?.[field.key]);

              if (field.type === "select") {
                return (
                  <div key={field.key} data-field={field.key}>
                    <Select
                      label={fieldLabel}
                      value={String(values[field.key] ?? "")}
                      disabled={!canManage}
                      error={error}
                      options={(field.options ?? []).map((option) => ({
                        value: option.value,
                        label: t(option.label_key as MessageKey) || option.value,
                      }))}
                      onChange={(e) => patchValues({ [field.key]: e.target.value })}
                    />
                  </div>
                );
              }
              if (field.type === "number") {
                return (
                  <div key={field.key} data-field={field.key}>
                    <Input
                      label={fieldLabel}
                      type="number"
                      min={field.min}
                      max={field.max}
                      required={required}
                      value={Number(values[field.key] ?? 0)}
                      disabled={!canManage}
                      error={error}
                      hint={
                        field.hint_key
                          ? t(field.hint_key as MessageKey)
                          : field.key === "renew_before_days"
                            ? t("cert.fieldRenewHint", {
                                min: field.min ?? 1,
                                max: field.max ?? 60,
                              })
                            : undefined
                      }
                      onChange={(e) => patchValues({ [field.key]: Number(e.target.value) })}
                    />
                  </div>
                );
              }
              if (field.secret) {
                return (
                  <div key={field.key} data-field={field.key}>
                    <Input
                      label={fieldLabel}
                      type="password"
                      autoComplete="new-password"
                      required={required}
                      value={secrets[field.key] ?? ""}
                      disabled={!canManage}
                      error={error}
                      placeholder={
                        active.secret_set?.[field.key]
                          ? t("cert.secretPlaceholderSet")
                          : t("cert.secretPlaceholder")
                      }
                      hint={
                        active.secret_set?.[field.key]
                          ? t("cert.providerSecretHint")
                          : t("cert.providerSecretNewHint")
                      }
                      onChange={(e) => patchSecrets({ [field.key]: e.target.value })}
                    />
                  </div>
                );
              }
              return (
                <div key={field.key} data-field={field.key}>
                  <Input
                    label={fieldLabel}
                    className="mono"
                    required={required}
                    value={String(values[field.key] ?? "")}
                    placeholder={field.placeholder}
                    disabled={!canManage}
                    error={error}
                    onChange={(e) => patchValues({ [field.key]: e.target.value })}
                  />
                </div>
              );
            })}
          </div>

          {attempted && errorCount > 0 ? (
            <div className="cert-picker-error" role="alert">
              {t("cert.formHasErrors", { n: errorCount })}
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
