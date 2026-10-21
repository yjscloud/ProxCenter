/* ==========================================================================
   ProxCenter — 控制台辅助面板（剪贴板 / 文件上传）

   为什么需要它：noVNC 本身只做画面与键鼠，剪贴板要靠客户的 VNC 服务端
   支持（虚拟机的 CutText 通常要装 vdagent；容器的 vncterm 往往根本不实现），
   粘贴一条命令经常「按了没反应」。所以这里提供两种通道：

   * 剪贴板通道 —— 走 RFB 的 CutText，成功与否取决于客户机；
   * 逐字符键入 —— 用 sendKey 把文本当成真实按键敲进去，不依赖客户机装任何
     东西，终端里一定生效（代价是只支持 ASCII，长文本会慢）。

   文件上传走「面板中转」：文件先传到面板，再生成一条 curl / PowerShell 命令
   让客户机自己拉回去（后端说明见 app/console_files.py）。这样虚拟机、容器、
   任何系统都成立，不需要 Guest Agent 或宿主机 SSH。
   ========================================================================== */

import { useCallback, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, IconButton } from './ui/Button';
import { ProgressBar } from './ui/ProgressBar';
import { IconClose, IconCopy, IconUpload } from './Icons';
import { errorMessage } from '../api/client';
import { consoleFilesApi } from '../api/endpoints';
import type { ConsoleFileUpload, GuestType } from '../api/types';
import { useToast } from '../hooks/useToast';
import { useT } from '../i18n';
import { formatBytes } from '../utils/format';

export type ConsoleAssistMode = 'clipboard' | 'files';

export interface ConsoleAssistProps {
  /** 是否展开。关闭时保持挂载，已上传的链接与输入内容不会丢 */
  open: boolean;
  mode: ConsoleAssistMode;
  onModeChange: (mode: ConsoleAssistMode) => void;
  onClose: () => void;
  /** 挂载点：控制台外壳。全屏时只有该元素及其后代可见，挂到 body 会看不见 */
  container: HTMLElement | null;
  connected: boolean;
  /** 客户机剪贴板（noVNC 的 clipboard 事件）*/
  guestClipboard: string;
  /** 走 RFB 剪贴板通道 */
  onPasteToGuest: (text: string) => void;
  /** 逐字符键入（不依赖客户机剪贴板） */
  onTypeToGuest: (text: string) => void;
  guestType: GuestType;
  node: string;
  vmid: number;
}

/** 逐字符键入的长度上限：按 6ms/字符算，再长用户会以为卡死了 */
export const TYPE_TEXT_LIMIT = 4000;

export function ConsoleAssist({
  open,
  mode,
  onModeChange,
  onClose,
  container,
  connected,
  guestClipboard,
  onPasteToGuest,
  onTypeToGuest,
  guestType,
  node,
  vmid,
}: ConsoleAssistProps) {
  const t = useT();
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<ConsoleFileUpload | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const copy = useCallback(
    async (text: string) => {
      const ok = await copyToClipboard(text);
      if (ok) {
        toast.success(t('common.copy'));
      } else {
        toast.warning(t('console.copyFailed'), t('console.copyManualHint'));
      }
    },
    [t, toast],
  );

  const readLocal = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        toast.info(t('console.clipboardEmpty'));
        return;
      }
      setDraft(text);
    } catch {
      /* 浏览器在非 HTTPS 或未授权时会直接抛错：提示用户手动粘贴 */
      toast.warning(t('console.readClipboardFailed'), t('console.readClipboardHint'));
      textareaRef.current?.focus();
    }
  }, [t, toast]);

  const typeDraft = () => {
    const text = draft;
    if (!text.trim()) return;
    if (text.length > TYPE_TEXT_LIMIT) {
      toast.warning(
        t('console.typeTooLong', { limit: TYPE_TEXT_LIMIT }),
        t('console.typeTooLongHint'),
      );
      return;
    }
    onTypeToGuest(text);
  };

  const pickFile = (next: File | null) => {
    setFile(next);
    setResult(null);
    setProgress(0);
  };

  const upload = async () => {
    if (!file || uploading) return;
    setUploading(true);
    setProgress(0);
    try {
      const res = await consoleFilesApi.upload(
        guestType === 'lxc' ? 'lxc' : 'qemu',
        file,
        { node, vmid },
        setProgress,
      );
      setResult(res);
      toast.success(t('console.fileUploaded'), t('console.fileUploadedHint'));
    } catch (err) {
      toast.error(t('console.fileUploadFailed'), errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  const revoke = async () => {
    if (!result) return;
    try {
      await consoleFilesApi.revoke(result.token);
      setResult(null);
      toast.success(t('console.fileRevoked'));
    } catch (err) {
      toast.error(t('common.opFailed'), errorMessage(err));
    }
  };

  /* 生成的命令必须能被客户机的 shell 原样解析：文件名与 URL 都套单引号，
     URL 里的文件名由后端做了 URL 编码，不含单引号；文件名里的单引号按
     各自的转义规则处理（POSIX 用 '\''，PowerShell 用 ''）。 */
  const curlCommand = useMemo(
    () =>
      result
        ? `curl -fL -o ${posixQuote(result.name)} ${posixQuote(result.url)}`
        : '',
    [result],
  );
  const pwshCommand = useMemo(
    () =>
      result
        ? `Invoke-WebRequest -Uri ${pwshQuote(result.url)} -OutFile ${pwshQuote(result.name)}`
        : '',
    [result],
  );

  if (!container) return null;

  return createPortal(
    <aside
      className={`console-assist${open ? ' is-open' : ''}`}
      aria-hidden={open ? undefined : true}
      role="dialog"
      aria-label={t('console.assistTitle')}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <header className="console-assist-head">
        <div className="console-assist-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'clipboard'}
            className={`console-assist-tab${mode === 'clipboard' ? ' is-active' : ''}`}
            onClick={() => onModeChange('clipboard')}
          >
            <IconCopy size={14} />
            {t('console.assistClipboard')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'files'}
            className={`console-assist-tab${mode === 'files' ? ' is-active' : ''}`}
            onClick={() => onModeChange('files')}
          >
            <IconUpload size={14} />
            {t('console.assistFiles')}
          </button>
        </div>
        <IconButton label={t('common.close')} onClick={onClose}>
          <IconClose size={16} />
        </IconButton>
      </header>

      <div className="console-assist-body">
        {mode === 'clipboard' ? (
          <>
            <p className="console-assist-hint">{t('console.pasteHint')}</p>
            <textarea
              ref={textareaRef}
              className="textarea mono console-assist-textarea"
              rows={6}
              value={draft}
              spellCheck={false}
              placeholder={t('console.pastePlaceholder')}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="console-assist-actions">
              <Button size="sm" onClick={() => void readLocal()}>
                {t('console.readLocalClipboard')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={!connected || !draft.trim()}
                onClick={() => onPasteToGuest(draft)}
              >
                {t('console.pasteToGuest')}
              </Button>
              <Button
                size="sm"
                disabled={!connected || !draft.trim()}
                onClick={typeDraft}
                title={t('console.typeToGuestHint')}
              >
                {t('console.typeToGuest')}
              </Button>
            </div>
            <p className="console-assist-hint">{t('console.typeVsPaste')}</p>

            <div className="console-assist-section">
              <div className="console-assist-section-head">
                <span>{t('console.guestClipboard')}</span>
                {guestClipboard ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void copy(guestClipboard)}
                  >
                    {t('common.copy')}
                  </Button>
                ) : null}
              </div>
              {guestClipboard ? (
                <pre className="console-command">{clipPreview(guestClipboard)}</pre>
              ) : (
                <p className="console-assist-hint">{t('console.guestClipboardEmpty')}</p>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="console-assist-hint">{t('console.fileHint')}</p>
            <label
              className={`console-drop${dragging ? ' is-drag' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                pickFile(e.dataTransfer.files?.[0] ?? null);
              }}
            >
              <input
                type="file"
                hidden
                disabled={uploading}
                onChange={(e) => {
                  pickFile(e.target.files?.[0] ?? null);
                  /* 清空 value：连续选同一个文件时 onChange 才会再次触发 */
                  e.target.value = '';
                }}
              />
              <IconUpload size={18} />
              <span className="console-drop-name">
                {file ? file.name : t('console.chooseFile')}
              </span>
              <span className="console-assist-hint">
                {file ? formatBytes(file.size) : t('console.chooseFileHint')}
              </span>
            </label>

            {uploading ? (
              <ProgressBar value={progress} showValue label={t('console.uploading')} />
            ) : null}

            <div className="console-assist-actions">
              <Button
                size="sm"
                variant="primary"
                loading={uploading}
                disabled={!file || uploading}
                onClick={() => void upload()}
              >
                {t('console.uploadFile')}
              </Button>
              {file ? (
                <Button size="sm" onClick={() => pickFile(null)} disabled={uploading}>
                  {t('common.cancel')}
                </Button>
              ) : null}
            </div>

            {result ? (
              <div className="console-assist-section">
                <div className="console-assist-section-head">
                  <span>{t('console.fileReady')}</span>
                  <Button size="sm" variant="ghost" onClick={() => void revoke()}>
                    {t('console.fileRevoke')}
                  </Button>
                </div>
                <p className="console-assist-hint">
                  {t('console.fileMeta', {
                    name: result.name,
                    size: formatBytes(result.size),
                    time: new Date(result.expires_at * 1000).toLocaleString(),
                  })}
                </p>
                <CommandRow
                  label={t('console.cmdLinux')}
                  command={curlCommand}
                  onCopy={() => void copy(curlCommand)}
                  onType={() => onTypeToGuest(curlCommand)}
                  typeDisabled={!connected}
                />
                <CommandRow
                  label={t('console.cmdWindows')}
                  command={pwshCommand}
                  onCopy={() => void copy(pwshCommand)}
                  onType={() => onTypeToGuest(pwshCommand)}
                  typeDisabled={!connected}
                />
                <p className="console-assist-hint">{t('console.fileCmdHint')}</p>
              </div>
            ) : null}
          </>
        )}
      </div>
    </aside>,
    container,
  );
}

/* ---------------------------------------------------------------------------
   命令行：复制 / 直接键入客户机
   --------------------------------------------------------------------------- */

function CommandRow({
  label,
  command,
  onCopy,
  onType,
  typeDisabled,
}: {
  label: string;
  command: string;
  onCopy: () => void;
  onType: () => void;
  typeDisabled: boolean;
}) {
  const t = useT();
  return (
    <div className="console-command-block">
      <div className="console-assist-section-head">
        <span>{label}</span>
      </div>
      <pre className="console-command">{command}</pre>
      <div className="console-assist-actions">
        <Button size="sm" variant="ghost" onClick={onCopy}>
          {t('common.copy')}
        </Button>
        <Button size="sm" disabled={typeDisabled} onClick={onType}>
          {t('console.typeToGuest')}
        </Button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   小工具
   --------------------------------------------------------------------------- */

function clipPreview(text: string): string {
  return text.length > 2000 ? `${text.slice(0, 2000)}\n…` : text;
}

function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function pwshQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 非安全上下文 / 未授权：走下面的兜底 */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
