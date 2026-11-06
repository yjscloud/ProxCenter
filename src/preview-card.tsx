/* 临时预览入口：签发渠道列表 + 添加弹窗（含 ACME 的条件字段），不参与构建。 */
import "./preview-lang";
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { I18nProvider, ensureDict } from "./i18n";
import { CertProvidersCard } from "./components/CertProvidersCard";
import type { CertProviderField, CertProviderInfo } from "./api/types";

import "./styles/theme.css";
import "./styles/global.css";
import "./styles/components.css";
import "./styles/layout.css";

const vendorFields: CertProviderField[] = [
  { key: "secret_id", label_key: "cert.fieldSecretId", required: true },
  { key: "secret_key", label_key: "cert.fieldSecretKey", type: "password", secret: true, required: true },
  {
    key: "validate_type",
    label_key: "cert.fieldValidateType",
    type: "select",
    options: [
      { value: "DNS_AUTO", label_key: "cert.dvAuthAuto" },
      { value: "DNS", label_key: "cert.dvAuthDns" },
    ],
  },
  { key: "renew_before_days", label_key: "cert.fieldDefaultRenewDays", type: "number", min: 1, max: 60 },
];

const acmeFields: CertProviderField[] = [
  { key: "email", label_key: "cert.acmeEmail", required: true, placeholder: "ops@example.com" },
  {
    key: "directory",
    label_key: "cert.acmeDirectory",
    type: "select",
    required: true,
    options: [
      { value: "https://acme-v02.api.letsencrypt.org/directory", label_key: "cert.acmeDir_letsencrypt" },
      { value: "https://acme.zerossl.com/v2/DV90", label_key: "cert.acmeDir_zerossl" },
    ],
  },
  {
    key: "encrypt_algo",
    label_key: "cert.acmeKeyAlgo",
    type: "select",
    options: [
      { value: "RSA", label_key: "cert.algoRsa" },
      { value: "ECC", label_key: "cert.algoEcc" },
    ],
  },
  {
    key: "dns_provider",
    label_key: "cert.acmeProvider",
    type: "select",
    options: [
      { value: "", label_key: "cert.acmeProviderNone" },
      { value: "dnspod", label_key: "cert.dnsProvider_dnspod" },
      { value: "cloudflare", label_key: "cert.dnsProvider_cloudflare" },
    ],
  },
  { key: "dns_wait", label_key: "cert.acmeWait", type: "number", min: 0, max: 900 },
  {
    key: "dnspod_secret_id",
    label_key: "cert.fieldSecretId",
    required: true,
    show_if: { key: "dns_provider", in: ["dnspod"] },
  },
  {
    key: "dnspod_secret_key",
    label_key: "cert.fieldSecretKey",
    type: "password",
    secret: true,
    required: true,
    show_if: { key: "dns_provider", in: ["dnspod"] },
  },
  {
    key: "cloudflare_api_token",
    label_key: "cert.fieldApiToken",
    type: "password",
    secret: true,
    required: true,
    show_if: { key: "dns_provider", in: ["cloudflare"] },
  },
];

const providers: CertProviderInfo[] = [
  {
    kind: "tencent",
    label: "腾讯云 SSL 证书",
    label_key: "cert.providerTencent",
    tagline_key: "cert.providerTencentTagline",
    help_url: "https://console.cloud.tencent.com/cam/capi",
    configured: true,
    identity_key: "secret_id",
    fields: vendorFields,
    values: { secret_id: "AKIDzQ8Kd2mPq7Xr", validate_type: "DNS_AUTO", renew_before_days: 15 },
    secret_set: { secret_key: true },
  },
  {
    kind: "aliyun",
    label: "阿里云数字证书",
    label_key: "cert.providerAliyun",
    tagline_key: "cert.providerAliyunTagline",
    help_url: "https://ram.console.aliyun.com/manage/ak",
    configured: false,
    identity_key: "access_key_id",
    fields: [
      { key: "access_key_id", label_key: "cert.fieldAccessKeyId", required: true },
      { key: "access_key_secret", label_key: "cert.fieldAccessKeySecret", type: "password", secret: true, required: true },
      { key: "renew_before_days", label_key: "cert.fieldDefaultRenewDays", type: "number", min: 1, max: 60 },
    ],
    values: { access_key_id: "", renew_before_days: 15 },
    secret_set: {},
  },
  {
    kind: "huawei",
    label: "华为云证书管理（SCM）",
    label_key: "cert.providerHuawei",
    tagline_key: "cert.providerHuaweiTagline",
    help_url: "https://console.huaweicloud.com/iam/",
    configured: false,
    identity_key: "access_key_id",
    fields: vendorFields,
    values: { secret_id: "", validate_type: "DNS_AUTO", renew_before_days: 15 },
    secret_set: {},
  },
  {
    kind: "acme",
    label: "ACME（Let's Encrypt / ZeroSSL）",
    label_key: "cert.providerAcme",
    tagline_key: "cert.providerAcmeTagline",
    help_url: "https://letsencrypt.org/zh-cn/docs/",
    configured: true,
    identity_key: "email",
    test_disabled: true,
    synchronous: true,
    fields: acmeFields,
    values: {
      email: "ops@example.com",
      directory: "https://acme-v02.api.letsencrypt.org/directory",
      encrypt_algo: "RSA",
      dns_provider: "dnspod",
      dns_wait: 30,
      dnspod_secret_id: "id-1234567890",
      dnspod_secret_key: "",
      cloudflare_api_token: "",
    },
    secret_set: { dnspod_secret_key: true, cloudflare_api_token: false },
  },
];

function App() {
  const [, setTick] = useState(0);
  useEffect(() => {
    void ensureDict("settings").then(() => setTick((v) => v + 1));
  }, []);
  return (
    <div style={{ padding: 24, maxWidth: 1120, background: "var(--bg)", minHeight: "100vh" }}>
      <CertProvidersCard
        providers={providers}
        canManage
        busy=""
        onSave={async () => true}
        onTest={() => undefined}
      />
    </div>
  );
}

try {
  localStorage.setItem("pve_lang", "zh-CN");
} catch {
  /* 忽略 */
}

createRoot(document.getElementById("root")!).render(
  <I18nProvider>
    <App />
  </I18nProvider>,
);
