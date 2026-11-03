/* ==========================================================================
   pvecenter — English messages · ai（业务域）
   --------------------------------------------------------------------------
   与中文同组词条一一对应，按同样的路由时机加载（见 i18n/index.tsx）。
   声明成 Partial：没翻的词条直接不写，运行时会回退中文原文。
   ========================================================================== */

import type { MessageKey } from './zh-CN';

export const enAi: Partial<Record<MessageKey, string>> = {
  'ai.title': 'AI inspection assistant',
  'ai.subtitle':
    'Describe the symptom or just ask a question — the AI signs in to this host, runs diagnostic commands and answers as it goes. Read-only commands run directly; anything that changes the system needs your approval, command by command.',
  'ai.runningHint': 'Calling the model and running commands; usually 10-60 seconds',
  'ai.settings': 'Model settings',
  'ai.selectHost': 'Target host',
  'ai.selectHostPlaceholder': 'Select…',
  'ai.pickHostTitle': 'Pick the host to inspect first',
  'ai.pickHostHint':
    'The AI signs in to that host to read logs and run commands, so the target must be chosen by you — the panel never preselects one, because inspecting the wrong machine is far worse than one extra click.',
  'ai.noHostTitle': 'No managed host yet',
  'ai.noHostHint':
    'Inspection only works on servers registered under “SSH security → Managed hosts”. Add the machine you want to inspect first; then it shows up here.',
  'ai.notConfigured': 'No model configured yet',
  'ai.notConfiguredHint':
    'The assistant needs an LLM. External APIs (DeepSeek / OpenAI / …) and self-hosted models (vLLM / Ollama) are configured the same way.',
  'ai.configureNow': 'Configure',

  'ai.settingsTitle': 'Model settings',
  'ai.settingsDesc': 'Applies to the whole platform; the key is encrypted on the backend and never sent to the browser',
  'ai.enable': 'Enable the AI assistant',
  'ai.enableHint': 'When off, nobody can start an inspection',
  'ai.provider': 'Model',
  'ai.providerName': 'Name',
  'ai.providerNameHint': 'To tell several models apart, e.g. “DeepSeek (external)”',
  'ai.providerKind': 'Type',
  'ai.kindExternal': 'External API (public internet)',
  'ai.kindInternal': 'Self-hosted (no egress)',
  'ai.baseUrl': 'Base URL',
  'ai.baseUrlHint': 'e.g. https://api.example.com/v1 (an OpenAI-compatible endpoint)',
  'ai.apiKey': 'API key',
  'ai.apiKeyHint': 'Leave blank to keep the saved key',
  'ai.apiKeyPlaceholder': 'sk-… (may be blank for a self-hosted model)',
  'ai.apiKeyKeep': 'A key is saved; leave blank to keep it',
  'ai.model': 'Model name',
  'ai.modelHint': 'e.g. deepseek-chat, qwen2.5:14b',
  'ai.addProvider': 'Add model',
  'ai.removeProvider': 'Remove',
  'ai.test': 'Test connection',
  'ai.testOk': 'Connected',
  'ai.testFailed': 'Connection failed',
  'ai.save': 'Save settings',
  'ai.saved': 'Settings saved',
  'ai.saveFailed': 'Failed to save',
  'ai.fieldRequired': 'Name, base URL and model name are required',
  'ai.hours': 'Analysis window (hours)',
  'ai.hoursHint': 'How far back the collected data reaches; 24 hours by default',
  'ai.tokenBudget': 'Token budget per run',
  'ai.tokenBudgetHint':
    'Accumulated across rounds; once reached the model concludes from what it has. Default 60000, up to 100 million. The real brakes are the round count and the overall timeout — this is just a backstop.',
  'ai.replyCharsTerse': 'Reply length — chat (chars)',
  'ai.replyCharsTerseHint':
    'Character limit for everyday Q&A answers; 150 by default. Too short drops the evidence, too long reads like a dump of the tool output.',
  'ai.replyCharsDeep': 'Reply length — playbook (chars)',
  'ai.replyCharsDeepHint':
    'Character limit for the report produced after a playbook run; 400 by default.',

  'ai.failed': 'Inspection failed',
  'ai.disclaimer':
    'The AI output is advisory and may miss or misjudge things. It signs in to the target host and runs commands (disk, processes, logs, config): read-only diagnostics run directly, while anything that changes the system needs your approval command by command. Every command it runs is listed under “Progress” on the left — check it before acting.',
  'ai.readonlyTip':
    'Inspections default to built-in read-only commands (df / ps / ss / journalctl …). Every tool and argument is validated against an allowlist, and sudo is never used; once on-host execution is granted, the AI may also propose commands that change the system, but each one needs your approval. Use a regular account on managed hosts — do not give the assistant root.',

  'ai.progressTitle': 'Progress',
  'ai.progressDone': 'Finished',
  'ai.stageCollect': 'Collecting inspection data…',
  'ai.stepN': 'Analysis round {n} / {max}',
  'ai.toolStart': 'Calling {tool}{args}',
  'ai.toolDone': '{mark} {tool} finished ({ms} ms)',
  'ai.progressIdle': 'Not started',
  'ai.progressEmpty':
    'Once you run a health check or ask a question, every step the AI takes shows up here live.',
  'ai.chatTitle': 'Chat & approval',
  'ai.chatSubtitle': 'Approve the AI’s requests one by one',
  'ai.chatIntro':
    'Describe the symptom or just ask a question (e.g. “why is nginx returning 502?”) and I’ll dig in as we go. Want a full report instead? Click “Run health check”.',
  'ai.chatUserRequest': 'Health check on {host} (model: {model})',
  'ai.chatWorking': 'Looking things up and analysing…',
  'ai.chatPlaceholder': 'Ask a follow-up…',
  'ai.chatSend': 'Send',
  'ai.chatTarget': 'Target host: {host}',
  'ai.playbookPick': 'Run a playbook…',
  'ai.playbookPickHint':
    'Pick a preset troubleshooting playbook and work through it in order',
  'ai.needsHostTitle': 'Pick the host to inspect first',
  'ai.needsHostHint':
    'This question came from another page, but that machine is not registered as a '
    + 'managed host, so the AI cannot reach it. To avoid inspecting the wrong machine '
    + 'we will not pick one for you — choose a target host above (or add the machine '
    + 'under “SSH security → Managed hosts”).',
  'ai.chatNew': 'New chat',
  'ai.chatNewHint': 'Start a fresh conversation (does not reuse the current context)',
  'ai.chatHistory': 'History',
  'ai.progressHistory': 'Actions taken in this conversation',
  'ai.toolHistoryLine': '{mark} {tool}',

  /* 一键体检与报告卡 */
  'ai.start': 'Run health check',
  'ai.startHint': 'Collects the check data and produces a full report. To just ask something, type in the box below.',
  'ai.running': 'Running',
  'ai.quickInspect': 'Digest only',
  'ai.quickHint':
    'Reads the existing inspection results only — no host login, no tool calls. Use this with models that do not support tool calling.',
  'ai.summaryTitle': 'Summary',
  'ai.findingsTitle': 'Findings',
  'ai.findingsHint': 'Sorted by severity; click a title for evidence and the suggested action',
  'ai.noFindings': 'Nothing needs attention.',
  'ai.evidence': 'Evidence',
  'ai.suggestion': 'Suggested action',
  'ai.dataGaps': 'Still unclear',
  'ai.dataGapsHint': 'Without these the conclusion is not final',
  'ai.confidence': 'Confidence',
  'ai.metaModel': 'Model: {model}',
  'ai.metaTime': '{ms} ms',
  'ai.metaTokens': 'Tokens: {tokens}',
  'ai.metaTools': '{n} tool call(s)',
  'ai.viewDetails': 'Show evidence',
  'ai.hideDetails': 'Hide evidence',
  'ai.remediation.action': 'Fix it',
  'ai.reinspect': 'Re-inspect',
  'ai.diffTitle': 'Compared with the previous run',
  'ai.diffAdded': '{n} new',
  'ai.diffResolved': '{n} resolved',
  'ai.diffSame': 'The rest is unchanged',
  'ai.gotoLabel': 'Go to',
  'ai.recConclusion': 'Conclusion',
  'ai.recConvReport': 'Report',
  'ai.recConvHasReport': 'Yes',
  'ai.recConvNoReport': 'No',
  'ai.doneTitle': 'Health check finished',
  'ai.doneDetail': '{n} item(s) need attention',

  /* Remote terminal (left pane) */
  'ai.terminalTitle': 'Server terminal',
  'ai.terminalSubtitle': 'Work directly on the managed host',
  'ai.terminalHint':
    'Terminal: {host}. Commands you type and commands the AI runs both appear in this window.',
  'ai.terminalIdle': 'Not connected',
  'ai.terminalConnecting': 'Connecting…',
  'ai.terminalConnected': 'Connected',
  'ai.terminalDisconnected': 'Disconnected',
  'ai.terminalClosed': 'Connection closed',
  'ai.terminalError': 'Terminal connection failed',
  'ai.terminalErrorHint':
    'Even the preflight check did not complete — usually your session has expired or the panel is unreachable. Sign in again and retry; if it still fails, look for the “AI 终端握手被拒” line in the backend log.',
  'ai.terminalStaleHint':
    'The backend has no “terminal preflight” endpoint, which means it is still running an older build. Restart the backend (and rebuild the frontend), then retry.',
  'ai.terminalProxyHint':
    'The backend preflight passed (permission, host ownership and SSH reachability are all fine) but the WebSocket handshake did not succeed — usually the reverse proxy is not forwarding WebSocket. Make sure the nginx location block sets proxy_set_header Upgrade $http_upgrade; and proxy_set_header Connection "upgrade"; (see the “Enabling HTTPS” section of the README for a full example).',
  'ai.terminalReconnect': 'Reconnect',
  'ai.terminalReconnectHint': 'Drop the current connection and open a new terminal',
  'ai.terminalNoPermission':
    'You do not have the “Remote terminal” permission, so you cannot sign in to a managed host from here. Ask an administrator to grant it in your role.',
  'ai.terminalNeedHost':
    'Pick a managed host above first — the terminal only opens for managed hosts (the panel host itself is not exposed).',

  /* Token usage monitoring */
  'ai.usage.open': 'Token usage',
  'ai.usage.title': 'Token usage',
  'ai.usage.heroCaption': 'Last {days} days',
  'ai.usage.modalDesc':
    'Tokens spent, runs and per-model breakdown for the selected window.',
  'ai.usage.subtitle': 'Last {days} days · {runs} runs',
  'ai.usage.subtitleEmpty': 'No usage in this window',
  'ai.usage.windowDays': '{n}d',
  'ai.usage.windowLabel': 'Window',
  'ai.usage.totalTokens': 'Total',
  'ai.usage.promptTokens': 'Input',
  'ai.usage.completionTokens': 'Output',
  'ai.usage.runs': 'Runs',
  'ai.usage.avgTokens': 'Avg / run',
  'ai.usage.toolCalls': 'Tool calls',
  'ai.usage.avgDuration': 'Avg duration',
  'ai.usage.splitAria': 'Input vs output token split',
  'ai.usage.unit': 'tokens',
  'ai.usage.trend': 'Daily usage',
  'ai.usage.dayTip': '{day} · {n} tokens',
  'ai.usage.byModel': 'By model',
  'ai.usage.runsUnit': '{n} runs',
  'ai.usage.unknownModel': 'Unknown model',
  'ai.usage.noData': 'No usage data',
  'ai.usage.noDataDesc':
    'Run an inspection or ask a question, and the tokens spent over the last {n} days will show up here.',
  'ai.usage.loadFailed': 'Cannot load usage',
  'ai.usage.loadFailedMsg':
    'Try again later, or check each run in “Inspection history”.',

  'ai.tabInspect': 'Inspect',
  'ai.tabRecords': 'History',

  'ai.preset': 'Vendor preset',
  'ai.presetHint':
    'Pick one to fill in the endpoint and common model names automatically, or choose manual entry',
  'ai.presetManual': 'Manual entry',
  'ai.presetCustom': 'Other OpenAI-compatible service',
  'ai.modelSuggest': 'Common models:',
  'ai.recTime': 'Time',
  'ai.recHost': 'Host',
  'ai.recModel': 'Model',
  'ai.recStatus': 'Status',
  'ai.recSteps': 'Rounds',
  'ai.recTools': 'Tool calls',
  'ai.recTokens': 'Tokens',
  'ai.recDuration': 'Duration',
  'ai.recFilterHost': 'Filter by host',
  'ai.recAllHosts': 'All hosts',
  'ai.recTotal': '{n} record(s)',
  'ai.recEmptyTitle': 'No inspection history yet',
  'ai.recEmptyDesc': 'Once you run an inspection, every step the AI took shows up here.',
  'ai.recClickHint': 'Click to see the tools this run executed',
  'ai.recPrev': 'Previous',
  'ai.recNext': 'Next',
  'ai.recDetail': 'Tool call details',
  'ai.recDetailHint': 'What the AI actually executed during this run',
  'ai.recClose': 'Collapse',
  'ai.recOpenConversation': 'Open in chat',
  'ai.recOpenConversationHint':
    'Open this run’s conversation on the Inspect tab and keep asking follow-ups',
  'ai.recNoCalls': 'This run called no tools (digest only)',
  'ai.recViewRuns': 'Runs',
  'ai.recViewConversations': 'Conversations',
  'ai.recConvRuns': 'Runs',
  'ai.recConvEmptyTitle': 'No conversations yet',
  'ai.recConvEmptyDesc':
    'Start an inspection on the Inspect tab and a conversation will be created.',
  'ai.recConvDetail': 'Conversation',
  'ai.recConvDetailHint': 'Messages and tool calls in this conversation',
  'ai.recConvEmptyMessages': 'This conversation has no messages yet',
  'ai.recRoleUser': 'User',
  'ai.recRoleAssistant': 'AI',
  'ai.recRoleTool': 'Tool',
  'ai.sharedModel': 'Shared',
  'ai.capabilities': 'Capabilities',
  'ai.allowExec': 'Let the AI run commands on the target host',
  'ai.allowExecHint':
    'With this on, the AI may compose and run its own read-only diagnostics (e.g. ps aux | grep nginx). Commands that change the system are never run directly — they wait for your approval, one at a time. Read-only commands use an allowlist, never sudo, and everything is recorded in the inspection log.',
  'ai.allowExecWarn':
    'Commands that change the system run only after you approve them one by one; the grant applies to this run only.',
  'ai.approval.title': 'Approve the AI’s command',
  'ai.approval.badge': 'Write',
  'ai.approval.countdown': 'auto-rejected in {s}s',
  'ai.approval.purpose': 'Why the AI wants it',
  'ai.approval.command': 'Command to run',
  'ai.approval.approve': 'Approve and run',
  'ai.approval.reject': 'Reject',
  'ai.stop': 'Stop',
  'ai.remediation.title': 'Confirm remediation',
  'ai.remediation.previewing': 'Generating preview…',
  'ai.remediation.steps': 'Will run',
  'ai.remediation.risk.reversible': 'Reversible',
  'ai.remediation.risk.irreversible': 'Irreversible',
  'ai.remediation.irreversibleHint': 'This is irreversible (cuts network / powers off, etc.). Make sure the target is correct before running.',
  'ai.remediation.confirm': 'Run it',
  'ai.remediation.doneTitle': 'Remediation submitted',
  'ai.remediation.doneDetail': '“{label}” was executed; see the audit log for details.',
  'ai.abortedTitle': 'Inspection stopped',
  'ai.abortedHint': 'Stopped at the current step — no further model calls will be made',
  'ai.searchUser': 'Search username…',
  'ai.noMatchUser': 'No matching user',
  'ai.grantedCount': 'Granted to {n} user(s)',
  'ai.revokeGrant': 'Revoke access for {name}',
  'ai.connected': 'Connected',
  'ai.incomplete': 'Incomplete',
  'ai.connectFailed': 'Connection failed',
  'ai.badgeHint':
    '“Connected” only means the required fields are filled in — use Test connection to verify it actually works',
  'ai.grantTo': 'Grant to',
  'ai.grantHint':
    'Selected users can inspect with this model, but cannot see its key or modify it',
  'ai.noOtherUsers': 'No other users',
  'ai.grantBadge': 'granted',
  'ai.myModels': 'My models',
  'ai.noMyModel': "You haven't configured your own model yet",
  'ai.noMyModelHint':
    'Add your own model endpoint to run inspections — only you can use it, and only you are billed for it.',
  'ai.capSubtitle': 'What it can and cannot do',
  'ai.capIntro':
    'Pick a host: it first reads the inspection data the platform already has, then signs in to run read-only commands if needed, and finally gives a conclusion with evidence.',
  'ai.capInternalTitle': 'Platform data (read-only)',
  'ai.capInternalBody':
    'Never touches the host — reads inspection results the platform already collected.',
  'ai.capHostTitle': 'Runs on the target host',
  'ai.capHostBody':
    'It really signs in and runs commands: read-only diagnostics run directly (paths and files are allowlisted); once granted, commands that change the system are proposed first and need your approval one at a time.',
  'ai.capLimitTitle': 'Limits',
  'ai.capLimitBody':
    'One inspection runs at most {steps} rounds within {seconds}s; every call is audited and can be reviewed one by one under “History”.',
  /* ---- Validation rules stay on the server: the page only says they exist ---- */
  'ai.capPolicyServerSide':
    'The exact command allowlist and the argument / path checks stay on the server instead of being listed here; every tool call is validated against that same policy and audited.',
  'ai.myModelsOnly':
    'You can only manage your own models here; shared ones are maintained by the admin',
  'ai.selectModel': 'Model',
  'ai.selectModelHint':
    'Applies to this inspection only; the default model set by the admin is unchanged',
  'ai.recExport': 'Export CSV',
  'ai.recExportHint':
    'Export inspection records with tool-call details; regular users export only their own records',
  'ai.stageQueued': 'Queued — waiting for a free slot…',
};
