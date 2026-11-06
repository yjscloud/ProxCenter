/* 预览入口专用：在 i18n 模块初始化之前把语言钉成中文。 */
try {
  localStorage.setItem("pve_lang", "zh-CN");
} catch {
  /* 忽略 */
}

export {};
