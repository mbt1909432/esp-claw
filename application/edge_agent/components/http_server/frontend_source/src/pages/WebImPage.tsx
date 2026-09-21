import {
  CircleX,
  Download,
  FileText,
  ImagePlus,
  LoaderCircle,
  Plus,
  RefreshCw,
  SendHorizontal,
  Trash2,
  WifiOff,
} from 'lucide-solid';
import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type Component,
} from 'solid-js';
import type { JSX } from 'solid-js';
import {
  createFolder,
  deletePath,
  deleteWebimHistory,
  fetchConfigGroups,
  fetchStatus,
  fetchWebimHistory,
  fetchWebimStatus,
  sendWebimMessage,
  uploadFile,
  webimWebSocketUrl,
  type WebImMessage,
} from '../api/client';
import { TabShell } from '../components/layout/TabShell';
import { PageHeader } from '../components/ui/PageHeader';
import { Button } from '../components/ui/Button';
import { Banner } from '../components/ui/Banner';
import { Switch } from '../components/ui/Switch';
import { t } from '../i18n';
import { pushToast } from '../state/toast';

const LS_CHAT_ID = 'esp-claw-webim-chat-id';
const WEBIM_CACHE_DB = 'nova-webim-cache';
const WEBIM_CACHE_STORE = 'messages';
const WEBIM_FILE_RETENTION_MS = 60_000;
const MARKED_CDN_URL = 'https://esp-claw.com/clientjs/marked@18.0.4/marked.umd.min.js';
const DOMPURIFY_CDN_URL = 'https://esp-claw.com/clientjs/dompurify@3.4.5/purify.min.js';
const MARKED_CDN_INTEGRITY =
  'sha384-QIom/Ao3tGhg4C4VY5VTDrHMTPzgsih5cGuY30rd/xp6hWQ+xIGIZ4kxhaQQY+PB';
const DOMPURIFY_CDN_INTEGRITY =
  'sha384-7FXQySTrDscwsLx1i8RIqZM/JHoUVstx4CuL2b7tziI4Glhp3/3dm/j3qUTheVXE';

type MarkedRuntime = {
  parse: (text: string, options?: { async?: false }) => string | Promise<string>;
};

type DomPurifyRuntime = {
  sanitize: (html: string, config?: Record<string, unknown>) => string;
};

type LocalWebImMessage = WebImMessage & {
  localId?: string;
  sendStatus?: 'pending' | 'sent' | 'failed';
  files?: string[];
};

type PendingFile = {
  path: string;
  name: string;
  size: number;
  type: string;
  status: 'uploading' | 'ready' | 'failed';
};

const [webImMessages, setWebImMessages] = createSignal<LocalWebImMessage[]>([]);
let webImUserLocalSeq = 0;
let webImUserLocalId = 0;

declare global {
  interface Window {
    marked?: MarkedRuntime;
    DOMPurify?: DomPurifyRuntime;
  }
}

const MARKDOWN_SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    'a',
    'blockquote',
    'br',
    'code',
    'em',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'li',
    'ol',
    'p',
    'pre',
    's',
    'strong',
    'table',
    'tbody',
    'td',
    'th',
    'thead',
    'tr',
    'ul',
  ],
  ALLOWED_ATTR: ['href', 'title'],
  ALLOWED_URI_REGEXP: /^(?:(?:(?:https?|mailto|tel):|[#/]))/i,
};

let markdownRuntimePromise: Promise<void> | null = null;

function escapeMarkdownHtml(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function loadExternalScript(
  src: string,
  integrity: string,
  testReady: () => boolean,
): Promise<void> {
  if (testReady()) {
    return Promise.resolve();
  }

  const existing = document.querySelector<HTMLScriptElement>(`script[data-webim-md="${src}"]`);
  if (existing) {
    if (existing.dataset.loaded === '1') {
      return testReady() ? Promise.resolve() : Promise.reject(new Error(src));
    }
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener(
        'error',
        () => {
          existing.remove();
          reject(new Error(src));
        },
        { once: true },
      );
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.integrity = integrity;
    script.dataset.webimMd = src;
    script.onload = () => {
      script.dataset.loaded = '1';
      testReady() ? resolve() : reject(new Error(src));
    };
    script.onerror = () => {
      script.remove();
      reject(new Error(src));
    };
    document.head.append(script);
  });
}

async function loadMarkdownRuntime(): Promise<void> {
  if (window.marked?.parse && window.DOMPurify?.sanitize) {
    return;
  }

  markdownRuntimePromise ??= Promise.all([
    loadExternalScript(MARKED_CDN_URL, MARKED_CDN_INTEGRITY, () => !!window.marked?.parse),
    loadExternalScript(
      DOMPURIFY_CDN_URL,
      DOMPURIFY_CDN_INTEGRITY,
      () => !!window.DOMPurify?.sanitize,
    ),
  ]).then(() => undefined);

  try {
    await markdownRuntimePromise;
  } catch (error) {
    markdownRuntimePromise = null;
    throw error;
  }
}

function renderMarkdown(text: string): string {
  const html = window.marked?.parse(escapeMarkdownHtml(text), { async: false });
  if (typeof html !== 'string') {
    return '';
  }
  return window.DOMPurify?.sanitize(html, MARKDOWN_SANITIZE_CONFIG) ?? '';
}

const MarkdownMessage: Component<{ preview: boolean; text: string }> = (props) => (
  <Show
    when={props.preview}
    fallback={<p class="m-0 whitespace-pre-wrap break-words">{props.text}</p>}
  >
    <div class="webim-markdown break-words" innerHTML={renderMarkdown(props.text)} />
  </Show>
);

function createChatId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : 'w-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function normalizeHistoryItem(item: Record<string, unknown>, index: number): LocalWebImMessage | null {
  const role = item.role === 'assistant' || item.role === 'user' ? item.role : '';
  if (!role) return null;
  const content = item.content ?? item.text;
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((part) => {
        const value = part as Record<string, unknown>;
        return typeof value.text === 'string' ? value.text : '';
      })
      .filter(Boolean)
      .join('');
  }
  if (!text) return null;
  return {
    seq: typeof item.seq === 'number' ? item.seq : index + 1,
    role,
    text,
    ts_ms: typeof item.ts_ms === 'number' ? item.ts_ms : undefined,
    message_id: typeof item.message_id === 'string' ? item.message_id : undefined,
    sendStatus: role === 'user' ? 'sent' : undefined,
  };
}

async function compressImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/') || file.size <= 450 * 1024) return file;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.78));
  if (!blob || blob.size >= file.size) return file;
  return new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' });
}

function loadOrCreateChatId(): string {
  try {
    const saved = localStorage.getItem(LS_CHAT_ID);
    if (saved) return saved;
  } catch {
    /* ignore */
  }
  const id = createChatId();
  try {
    localStorage.setItem(LS_CHAT_ID, id);
  } catch {
    /* ignore */
  }
  return id;
}

function openMessageCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const request = indexedDB.open(WEBIM_CACHE_DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(WEBIM_CACHE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB unavailable'));
  });
}

async function loadCachedMessages(chatId: string): Promise<LocalWebImMessage[]> {
  try {
    const db = await openMessageCache();
    return await new Promise((resolve, reject) => {
      const request = db.transaction(WEBIM_CACHE_STORE, 'readonly').objectStore(WEBIM_CACHE_STORE).get(chatId);
      request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return [];
  }
}

async function saveCachedMessages(chatId: string, messages: LocalWebImMessage[]): Promise<void> {
  try {
    const db = await openMessageCache();
    await new Promise<void>((resolve, reject) => {
      const request = db
        .transaction(WEBIM_CACHE_STORE, 'readwrite')
        .objectStore(WEBIM_CACHE_STORE)
        .put(messages.slice(-200), chatId);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch {
    /* History recovery is best effort; the device remains the source of truth. */
  }
}

async function clearCachedMessages(chatId: string): Promise<void> {
  try {
    const db = await openMessageCache();
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(WEBIM_CACHE_STORE, 'readwrite').objectStore(WEBIM_CACHE_STORE).delete(chatId);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch {
    /* ignore */
  }
}

const WebImPageLegacy: Component = () => {
  const chatId = loadOrCreateChatId();
  /** In-memory transcript only — lost on refresh. */
  const messages = webImMessages;
  const setMessages = setWebImMessages;
  const [input, setInput] = createSignal('');
  const [pendingPaths, setPendingPaths] = createSignal<string[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [bound, setBound] = createSignal<boolean | null>(null);
  const [wsReady, setWsReady] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  const [markdownPreview, setMarkdownPreview] = createSignal(false);
  const [markdownPreviewLoading, setMarkdownPreviewLoading] = createSignal(false);
  let fileRef: HTMLInputElement | undefined;
  let messagesRef: HTMLDivElement | undefined;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const clearReconnect = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const clearHeartbeat = () => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const teardownWs = () => {
    clearReconnect();
    clearHeartbeat();
    if (ws) {
      ws.onopen = null;
      ws.onclose = null;
      ws.onmessage = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      ws = null;
    }
    setWsReady(false);
  };

  const scheduleReconnect = () => {
    clearReconnect();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWs();
    }, 2000);
  };

  const connectWs = () => {
    teardownWs();
    const socket = new WebSocket(webimWebSocketUrl());
    ws = socket;

    socket.onopen = () => {
      const hello = JSON.stringify({ type: 'hello', chat_id: chatId });

      setWsReady(true);
      clearReconnect();
      try {
        socket.send(hello);
      } catch {
        /* ignore */
      }
      clearHeartbeat();
      heartbeatTimer = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) {
          return;
        }
        try {
          socket.send('{"type":"ping"}');
        } catch {
          /* ignore */
        }
      }, 15000);
    };

    socket.onclose = () => {
      setWsReady(false);
      clearHeartbeat();
      scheduleReconnect();
    };

    socket.onerror = () => {
      setWsReady(false);
    };

    socket.onmessage = (ev: MessageEvent<string>) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(ev.data) as Record<string, unknown>;
      } catch {
        return;
      }
      const cid = typeof data.chat_id === 'string' ? data.chat_id : '';
      if (!cid || cid !== chatId) {
        return;
      }
      const role = typeof data.role === 'string' ? data.role : '';
      if (role !== 'assistant') {
        return;
      }
      const seq = typeof data.seq === 'number' ? data.seq : 0;
      const text = typeof data.text === 'string' ? data.text : '';
      const ts_ms = typeof data.ts_ms === 'number' ? data.ts_ms : undefined;
      let links: WebImMessage['links'];
      const rawLinks = data.links;
      if (Array.isArray(rawLinks)) {
        links = rawLinks.map((x) => {
          const o = x as Record<string, unknown>;
          return {
            url: typeof o.url === 'string' ? o.url : '',
            label: typeof o.label === 'string' ? o.label : '',
          };
        });
      }
      setMessages((prev) => [...prev, { seq, role: 'assistant', text, ts_ms, links }]);
    };
  };

  onMount(async () => {
    try {
      await createFolder('/inbox/webim', { recursive: true });
    } catch {
      /* may already exist */
    }
    try {
      const st = await fetchWebimStatus();
      setBound(!!st.bound);
    } catch {
      setBound(false);
    }
    connectWs();
  });

  onCleanup(() => {
    teardownWs();
  });

  createEffect(() => {
    messages().length;
    markdownPreview();
    requestAnimationFrame(() => {
      if (messagesRef) {
        messagesRef.scrollTop = messagesRef.scrollHeight;
      }
    });
  });

  const onPickFile = async (ev: Event) => {
    const inputEl = ev.currentTarget as HTMLInputElement;
    const file = inputEl.files?.[0];
    if (!file) return;
    const name = `${Date.now().toString(36)}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const path = '/inbox/webim/' + name;
    try {
      await uploadFile(path, file);
      setPendingPaths((p) => [...p, path]);
      pushToast(t('webimUploaded') as string, 'info', 2500);
    } catch (e) {
      pushToast((e as Error).message, 'error', 4000);
    }
    inputEl.value = '';
  };

  const makeLocalMessage = (text: string, files: string[]): LocalWebImMessage => {
    webImUserLocalSeq -= 1;
    webImUserLocalId += 1;
    return {
      seq: webImUserLocalSeq,
      role: 'user',
      text,
      files,
      localId: `user-${Date.now().toString(36)}-${webImUserLocalId.toString(36)}`,
      sendStatus: 'pending',
    };
  };

  const updateLocalMessageStatus = (
    localId: string,
    sendStatus: NonNullable<LocalWebImMessage['sendStatus']>,
  ) => {
    setMessages((prev) => prev.map((m) => (m.localId === localId ? { ...m, sendStatus } : m)));
  };

  const postLocalMessage = async (message: LocalWebImMessage) => {
    if (!message.localId) return;
    setSending(true);
    setError(null);
    try {
      await sendWebimMessage(chatId, message.text, message.files ?? []);
      updateLocalMessageStatus(message.localId, 'sent');
    } catch (e) {
      updateLocalMessageStatus(message.localId, 'failed');
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const send = async () => {
    const text = input().trim();
    const files = pendingPaths();
    if (!text && files.length === 0) return;
    if (!wsReady()) return;
    if (bound() === false) {
      pushToast(t('webimNoBind') as string, 'error', 5000);
      return;
    }
    const localMessage = makeLocalMessage(text, files);
    setMessages((prev) => [...prev, localMessage]);
    setInput('');
    setPendingPaths([]);
    await postLocalMessage(localMessage);
  };

  const retryMessage = async (message: LocalWebImMessage) => {
    if (!message.localId || sending() || !wsReady()) return;
    const retry = { ...message, sendStatus: 'pending' as const };
    setMessages((prev) => [...prev.filter((m) => m.localId !== message.localId), retry]);
    await postLocalMessage(retry);
  };

  const onInputKeyDown: JSX.EventHandler<HTMLTextAreaElement, KeyboardEvent> = (e) => {
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      if (!sending() && wsReady()) {
        void send();
      }
    }
  };

  const toggleMarkdownPreview = async (checked: boolean) => {
    if (!checked) {
      setMarkdownPreview(false);
      return;
    }

    setMarkdownPreviewLoading(true);
    try {
      await loadMarkdownRuntime();
      setMarkdownPreview(true);
    } catch {
      setMarkdownPreview(false);
      pushToast(t('webimMarkdownPreviewLoadFailed') as string, 'error', 5000);
    } finally {
      setMarkdownPreviewLoading(false);
    }
  };

  return (
    <TabShell class="flex h-[calc(100dvh-5.5rem)] min-h-[520px] flex-col sm:h-[calc(100dvh-6.5rem)]">
      <PageHeader
        title={t('navWebIm') as string}
        description={t('webimDesc') as string}
        actions={
          <Show when={wsReady()}>
            <span class="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-[rgba(104,211,145,0.2)] bg-[var(--color-green-dim)] text-[var(--color-green)] text-[0.78rem] font-medium">
              <span class="w-1.5 h-1.5 rounded-full bg-[var(--color-green)] pulse-dot" />
              {t('webimOnline')}
            </span>
          </Show>
        }
      />

      <Show when={error()}>
        <div class="px-5 pt-2">
          <Banner kind="error" message={error() ?? undefined} />
        </div>
      </Show>
      <Show when={bound() === false}>
        <div class="px-5 pt-2">
          <Banner kind="info" message={t('webimNoBind') as string} />
        </div>
      </Show>

      <div class="flex min-h-0 flex-1 flex-col">
        <div class="flex min-h-0 flex-1 flex-col min-w-0 border border-[var(--color-border-subtle)] rounded-none bg-white/[0.02]">
          <div
            ref={messagesRef}
            class="relative flex min-h-0 flex-1 overflow-auto p-4 flex-col gap-3"
          >
            <For each={messages()}>
              {(m) => (
                <div
                  class={[
                    'flex max-w-[min(100%,36rem)] items-start gap-2',
                    m.role === 'user' ? 'self-end' : 'self-start',
                  ].join(' ')}
                >
                  <Show when={m.role === 'user' && m.sendStatus !== 'sent'}>
                    <span class="mt-2 flex h-5 w-5 shrink-0 items-center justify-center">
                      <Show when={m.sendStatus === 'pending'}>
                        <LoaderCircle class="h-4 w-4 animate-spin text-[var(--color-text-muted)]" />
                      </Show>
                      <Show when={m.sendStatus === 'failed'}>
                        <button
                          type="button"
                          class="inline-flex h-5 w-5 items-center justify-center rounded-full text-[rgb(248,113,113)] transition hover:bg-[rgba(248,113,113,0.12)] hover:text-[rgb(252,165,165)] disabled:opacity-60"
                          title={t('webimRetrySend') as string}
                          aria-label={t('webimRetrySend') as string}
                          disabled={sending() || !wsReady()}
                          onClick={() => void retryMessage(m)}
                        >
                          <CircleX class="h-4 w-4" />
                        </button>
                      </Show>
                    </span>
                  </Show>
                  <div
                    class={[
                      'min-w-0 rounded-[var(--radius-md)] px-3 py-2 text-[0.88rem] leading-relaxed',
                      m.role === 'user'
                        ? 'bg-[var(--color-accent)]/18 text-[var(--color-text-primary)]'
                        : 'bg-white/6 text-[var(--color-text-primary)]',
                    ].join(' ')}
                  >
                    <MarkdownMessage preview={markdownPreview()} text={m.text} />
                    <Show when={(m.links?.length ?? 0) > 0}>
                      <ul class="mt-2 space-y-1 list-none m-0 p-0">
                        <For each={m.links ?? []}>
                          {(lnk) => (
                            <li>
                              <a
                                href={lnk.url}
                                download=""
                                class="text-[var(--color-accent-soft)] hover:underline text-[0.82rem]"
                              >
                                {lnk.label || lnk.url}
                              </a>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </div>
                </div>
              )}
            </For>
            <Show when={!wsReady() || messages().length === 0}>
              <div class="absolute inset-0 flex items-center justify-center p-4 pointer-events-none">
                <p
                  class={[
                    'm-0 text-center inline-flex items-center px-4 py-2 rounded-full border text-[0.82rem] font-medium',
                    !wsReady()
                      ? 'border-[rgba(245,158,11,0.28)] bg-[rgba(245,158,11,0.12)] text-[rgb(245,158,11)]'
                      : 'border-[rgba(104,211,145,0.2)] bg-[var(--color-green-dim)] text-[var(--color-green)]',
                  ].join(' ')}
                >
                  {!wsReady() ? (t('webimWsReconnecting') as string) : (t('webimEmpty') as string)}
                </p>
              </div>
            </Show>
          </div>

          <Show when={pendingPaths().length > 0}>
            <div class="px-4 pb-1 text-[0.76rem] text-[var(--color-text-muted)]">
              {t('webimPendingFiles')}: {pendingPaths().length}
            </div>
          </Show>

          <div class="p-3 border-t border-[var(--color-border-subtle)] flex flex-col gap-2">
            <textarea
              class="w-full min-h-[72px] rounded-[var(--radius-sm)] bg-black/25 border border-[var(--color-border-subtle)] px-3 py-2 text-[0.88rem] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)]"
              placeholder={t('webimPlaceholder') as string}
              value={input()}
              onInput={(e) => setInput(e.currentTarget.value)}
              onKeyDown={onInputKeyDown}
            />
            <div class="flex flex-wrap items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                class="hidden"
                onChange={(e) => void onPickFile(e)}
              />
              <Button
                size="sm"
                variant="secondary"
                type="button"
                onClick={() => fileRef?.click()}
                disabled={sending() || !wsReady()}
              >
                <span class="inline-flex items-center gap-1.5">
                  <ImagePlus class="w-4 h-4" />
                  {t('webimAttach')}
                </span>
              </Button>
              <Switch
                class="ml-1"
                labelClass="text-[var(--color-text-secondary)]"
                checked={markdownPreview()}
                disabled={markdownPreviewLoading()}
                onChange={(checked) => void toggleMarkdownPreview(checked)}
                label={
                  markdownPreviewLoading()
                    ? (t('webimMarkdownPreviewLoading') as string)
                    : (t('webimMarkdownPreview') as string)
                }
              />
              <span class="text-[0.76rem] text-[var(--color-text-muted)] sm:ml-auto">
                {t('webimSendShortcut')}
              </span>
              <Button
                size="sm"
                variant="primary"
                onClick={() => void send()}
                disabled={sending() || !wsReady()}
              >
                <span class="inline-flex items-center gap-1.5">
                  <SendHorizontal class="w-4 h-4" />
                  {t('webimSend')}
                </span>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </TabShell>
  );
};

export const WebImPage: Component = () => {
  const [chatId, setChatId] = createSignal(loadOrCreateChatId());
  const messages = webImMessages;
  const setMessages = setWebImMessages;
  const [input, setInput] = createSignal('');
  const [pendingFiles, setPendingFiles] = createSignal<PendingFile[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [historyError, setHistoryError] = createSignal<string | null>(null);
  const [historyLoading, setHistoryLoading] = createSignal(false);
  const [historyRestored, setHistoryRestored] = createSignal(false);
  const [bound, setBound] = createSignal<boolean | null>(null);
  const [wsReady, setWsReady] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  const [agentModel, setAgentModel] = createSignal('');
  const [visionSupported, setVisionSupported] = createSignal<boolean | null>(null);
  const [deviceIp, setDeviceIp] = createSignal('');
  const [wifiConnected, setWifiConnected] = createSignal<boolean | null>(null);
  const [storagePath, setStoragePath] = createSignal('');
  const [markdownPreview, setMarkdownPreview] = createSignal(false);
  const [markdownPreviewLoading, setMarkdownPreviewLoading] = createSignal(false);
  let fileRef: HTMLInputElement | undefined;
  let messagesRef: HTMLDivElement | undefined;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const pendingPaths = () => pendingFiles().map((file) => file.path);
  const messageKey = (message: LocalWebImMessage) =>
    message.message_id ? `id:${message.message_id}` : `${message.role}|${message.text}|${message.ts_ms ?? ''}`;

  const mergeMessages = (current: LocalWebImMessage[], incoming: LocalWebImMessage[]) => {
    const merged = [...current];
    for (const next of incoming) {
      const index = next.message_id
        ? merged.findIndex((item) => item.message_id === next.message_id)
        : merged.findIndex((item) => messageKey(item) === messageKey(next));
      if (index >= 0) {
        const old = merged[index];
        if (!old) continue;
        merged[index] = { ...old, ...next, localId: old.localId, sendStatus: old.sendStatus ?? next.sendStatus };
      } else {
        merged.push(next);
      }
    }
    return merged
      .filter((item) => item.text || (item.files?.length ?? 0) > 0)
      .sort((a, b) => (a.ts_ms ?? a.seq) - (b.ts_ms ?? b.seq));
  };

  const clearReconnect = () => {
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };
  const clearHeartbeat = () => {
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };
  const teardownWs = () => {
    clearReconnect();
    clearHeartbeat();
    if (ws) {
      ws.onopen = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      try { ws.close(); } catch { /* ignore */ }
      ws = null;
    }
    setWsReady(false);
  };

  const syncHistory = async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const items = await fetchWebimHistory(chatId());
      const restored = items
        .map((item, index) => normalizeHistoryItem(item, index))
        .filter((item): item is LocalWebImMessage => item !== null);
      setMessages((current) => mergeMessages(current, restored));
      setHistoryRestored(true);
    } catch (e) {
      setHistoryError((e as Error).message);
    } finally {
      setHistoryLoading(false);
    }
  };

  const scheduleReconnect = () => {
    clearReconnect();
    reconnectTimer = setTimeout(() => connectWs(), 2000);
  };

  const connectWs = () => {
    teardownWs();
    const socket = new WebSocket(webimWebSocketUrl());
    ws = socket;
    socket.onopen = () => {
      setWsReady(true);
      clearReconnect();
      try { socket.send(JSON.stringify({ type: 'hello', chat_id: chatId() })); } catch { /* ignore */ }
      clearHeartbeat();
      heartbeatTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          try { socket.send('{"type":"ping"}'); } catch { /* ignore */ }
        }
      }, 15000);
      void syncHistory();
    };
    socket.onclose = () => { setWsReady(false); clearHeartbeat(); scheduleReconnect(); };
    socket.onerror = () => setWsReady(false);
    socket.onmessage = (ev: MessageEvent<string>) => {
      let data: Record<string, unknown>;
      try { data = JSON.parse(ev.data) as Record<string, unknown>; } catch { return; }
      if (data.chat_id !== chatId() || data.role !== 'assistant') return;
      const rawLinks = Array.isArray(data.links) ? data.links : [];
      const links = rawLinks.map((item) => {
        const link = item as Record<string, unknown>;
        return { url: typeof link.url === 'string' ? link.url : '', label: typeof link.label === 'string' ? link.label : '' };
      });
      setMessages((current) => mergeMessages(current, [{
        seq: typeof data.seq === 'number' ? data.seq : 0,
        role: 'assistant',
        text: typeof data.text === 'string' ? data.text : '',
        ts_ms: typeof data.ts_ms === 'number' ? data.ts_ms : undefined,
        message_id: typeof data.message_id === 'string' ? data.message_id : undefined,
        links,
      }]));
    };
  };

  onMount(async () => {
    setMessages(await loadCachedMessages(chatId()));
    try {
      const config = await fetchConfigGroups(['llm']);
      setAgentModel(config.llm_model?.trim() || '未配置');
      const vision = config.llm_supports_vision?.trim().toLowerCase();
      setVisionSupported(vision === '1' || vision === 'true' || vision === 'yes');
    } catch { setAgentModel('未读取'); }
    try {
      const status = await fetchStatus();
      setDeviceIp(status.ip || '');
      setWifiConnected(!!status.wifi_connected);
      setStoragePath(status.storage_base_path || '');
    } catch { setWifiConnected(null); }
    try { await createFolder('/inbox/webim', { recursive: true }); } catch { /* already exists */ }
    try { setBound(!!(await fetchWebimStatus()).bound); } catch { setBound(false); }
    await syncHistory();
    connectWs();
  });
  onCleanup(teardownWs);

  createEffect(() => {
    const current = messages();
    void saveCachedMessages(chatId(), current);
    current.length;
    markdownPreview();
    requestAnimationFrame(() => { if (messagesRef) messagesRef.scrollTop = messagesRef.scrollHeight; });
  });

  const onPickFile = async (ev: Event) => {
    const inputEl = ev.currentTarget as HTMLInputElement;
    const file = inputEl.files?.[0];
    inputEl.value = '';
    if (!file) return;
    const lower = file.name.toLowerCase();
    const textFile = file.type === 'text/plain' || file.type === 'text/markdown' || lower.endsWith('.txt') || lower.endsWith('.md');
    if (!file.type.startsWith('image/') && !textFile) {
      pushToast(t('webimAttachmentTypeError') as string, 'error', 4000);
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      pushToast(t('webimAttachmentTooLarge') as string, 'error', 4000);
      return;
    }
    const path = `/inbox/webim/${Date.now().toString(36)}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    setPendingFiles((items) => [...items, { path, name: file.name, size: file.size, type: file.type, status: 'uploading' }]);
    try {
      const prepared = file.type.startsWith('image/') ? await compressImage(file) : file;
      if (prepared.size > 512 * 1024) throw new Error(t('webimAttachmentDeviceLimit') as string);
      await uploadFile(path, prepared);
      setPendingFiles((items) => items.map((item) => item.path === path ? { ...item, size: prepared.size, type: prepared.type, status: 'ready' } : item));
      pushToast(t('webimAttachmentReady') as string, 'info', 2500);
    } catch (e) {
      setPendingFiles((items) => items.map((item) => item.path === path ? { ...item, status: 'failed' } : item));
      pushToast((e as Error).message, 'error', 4000);
    }
  };

  const removePendingFile = async (path: string) => {
    setPendingFiles((items) => items.filter((item) => item.path !== path));
    try { await deletePath(path); } catch { /* best effort */ }
  };
  const makeLocalMessage = (text: string, files: string[]): LocalWebImMessage => {
    webImUserLocalSeq -= 1;
    webImUserLocalId += 1;
    return { seq: webImUserLocalSeq, role: 'user', text, files, localId: `user-${Date.now().toString(36)}-${webImUserLocalId.toString(36)}`, sendStatus: 'pending' };
  };
  const postLocalMessage = async (message: LocalWebImMessage) => {
    if (!message.localId) return;
    setSending(true);
    setError(null);
    try {
      await sendWebimMessage(chatId(), message.text, message.files ?? []);
      setMessages((items) => items.map((item) => item.localId === message.localId ? { ...item, sendStatus: 'sent' } : item));
    } catch (e) {
      setMessages((items) => items.map((item) => item.localId === message.localId ? { ...item, sendStatus: 'failed' } : item));
      setError((e as Error).message);
    } finally { setSending(false); }
  };
  const send = async () => {
    const text = input().trim();
    const allPending = pendingFiles();
    if (allPending.some((file) => file.status === 'uploading')) {
      pushToast(t('webimAttachmentWait') as string, 'info', 2500);
      return;
    }
    const files = allPending.filter((file) => file.status === 'ready');
    if ((!text && files.length === 0) || !wsReady()) return;
    if (bound() === false) { pushToast(t('webimNoBind') as string, 'error', 5000); return; }
    const message = makeLocalMessage(text, files.map((file) => file.path));
    setMessages((items) => [...items, message]);
    setInput('');
    setPendingFiles([]);
    await postLocalMessage(message);
    for (const file of allPending) window.setTimeout(() => { void deletePath(file.path).catch(() => undefined); }, WEBIM_FILE_RETENTION_MS);
  };
  const retryMessage = async (message: LocalWebImMessage) => {
    if (!message.localId || sending() || !wsReady()) return;
    const retry = { ...message, sendStatus: 'pending' as const };
    setMessages((items) => items.map((item) => item.localId === message.localId ? retry : item));
    await postLocalMessage(retry);
  };
  const onInputKeyDown: JSX.EventHandler<HTMLTextAreaElement, KeyboardEvent> = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (!sending()) void send(); }
  };
  const newChat = () => {
    teardownWs();
    const id = createChatId();
    setChatId(id);
    try { localStorage.setItem(LS_CHAT_ID, id); } catch { /* ignore */ }
    setMessages([]);
    setHistoryRestored(false);
    void connectWs();
  };
  const clearHistory = async () => {
    if (!window.confirm(t('webimClearHistoryConfirm') as string)) return;
    try {
      await deleteWebimHistory(chatId());
      await clearCachedMessages(chatId());
      setMessages([]);
      pushToast(t('webimClearHistoryDone') as string, 'success', 2500);
    } catch (e) { setError((e as Error).message); }
  };
  const exportHistory = () => {
    const body = messages().map((message) => `## ${message.role === 'user' ? 'User' : 'Nova'}\n\n${message.text}`).join('\n\n');
    const blob = new Blob([`# Web chat ${chatId()}\n\n${body}\n`], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `webim-${chatId().slice(0, 8)}.md`;
    link.click();
    URL.revokeObjectURL(url);
  };
  const toggleMarkdownPreview = async (checked: boolean) => {
    if (!checked) { setMarkdownPreview(false); return; }
    setMarkdownPreviewLoading(true);
    try { await loadMarkdownRuntime(); setMarkdownPreview(true); }
    catch { setMarkdownPreview(false); pushToast(t('webimMarkdownPreviewLoadFailed') as string, 'error', 5000); }
    finally { setMarkdownPreviewLoading(false); }
  };

  return (
    <TabShell class="flex h-[calc(100dvh-5.5rem)] min-h-[520px] flex-col sm:h-[calc(100dvh-6.5rem)]">
      <PageHeader title={t('navWebIm') as string} description={t('webimDesc') as string} actions={<>
        <span class={["inline-flex items-center gap-2 px-3 py-1 rounded-full border text-[0.78rem] font-medium", wsReady() ? "border-[rgba(104,211,145,0.2)] bg-[var(--color-green-dim)] text-[var(--color-green)]" : "border-[rgba(245,158,11,0.28)] bg-[rgba(245,158,11,0.12)] text-[rgb(245,158,11)]"].join(' ')}>{wsReady() ? t('webimOnline') : t('webimWsReconnecting')}</span>
        <Button size="xs" variant="ghost" title={t('webimRefreshHistory') as string} aria-label={t('webimRefreshHistory') as string} onClick={() => void syncHistory()}><RefreshCw class="h-4 w-4" /></Button>
        <Button size="xs" variant="ghost" title={t('webimNewChat') as string} aria-label={t('webimNewChat') as string} onClick={newChat}><Plus class="h-4 w-4" /></Button>
        <Button size="xs" variant="ghost" title={t('webimExportHistory') as string} aria-label={t('webimExportHistory') as string} disabled={messages().length === 0} onClick={exportHistory}><Download class="h-4 w-4" /></Button>
        <Button size="xs" variant="danger-ghost" title={t('webimClearHistory') as string} aria-label={t('webimClearHistory') as string} onClick={() => void clearHistory()}><Trash2 class="h-4 w-4" /></Button>
      </>} />
      <div class="px-5 pt-3"><div class="flex flex-wrap gap-x-4 gap-y-1 rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-white/[0.025] px-3 py-2 text-[0.76rem] text-[var(--color-text-muted)]">
        <span>{t('webimDevice')}: <strong class="text-[var(--color-text-secondary)]">{wifiConnected() === true ? t('webimDeviceOnline') : wifiConnected() === false ? t('webimDeviceOffline') : t('statusLoading')}{deviceIp() ? ` · ${deviceIp()}` : ''}</strong></span>
        <span>{t('webimModel')}: <strong class="text-[var(--color-text-secondary)]">{agentModel() || t('statusLoading')}</strong></span>
        <span>{t('webimVision')}: <strong class="text-[var(--color-text-secondary)]">{visionSupported() === true ? t('webimVisionSupported') : visionSupported() === false ? t('webimVisionUnsupported') : t('statusLoading')}</strong></span>
        <span>{bound() === true ? t('webimChatConnected') : bound() === false ? t('webimNoBindShort') : t('statusLoading')}</span>
        <Show when={storagePath()}><span>{t('webimStorage')}: <strong class="text-[var(--color-text-secondary)]">{storagePath()}</strong></span></Show>
        <Show when={historyRestored()}><span class="text-[var(--color-green)]">{t('webimHistoryRestored')}</span></Show>
      </div></div>
      <Show when={error()}><div class="px-5 pt-2"><Banner kind="error" message={error() ?? undefined} /></div></Show>
      <Show when={historyError()}><div class="px-5 pt-2"><Banner kind="error" message={historyError() ?? undefined} /></div></Show>
      <Show when={bound() === false}><div class="px-5 pt-2"><Banner kind="info" message={t('webimNoBind') as string} /></div></Show>
      <div class="flex min-h-0 flex-1 flex-col"><div class="flex min-h-0 flex-1 flex-col min-w-0 border border-[var(--color-border-subtle)] rounded-none bg-white/[0.02]">
        <div ref={messagesRef} class="relative flex min-h-0 flex-1 overflow-auto p-4 flex-col gap-3">
          <For each={messages()}>{(message) => <div class={["flex max-w-[min(100%,36rem)] items-start gap-2", message.role === 'user' ? 'self-end' : 'self-start'].join(' ')}>
            <Show when={message.role === 'user' && message.sendStatus !== 'sent'}><span class="mt-2 flex h-5 w-5 shrink-0 items-center justify-center"><Show when={message.sendStatus === 'pending'}><LoaderCircle class="h-4 w-4 animate-spin text-[var(--color-text-muted)]" /></Show><Show when={message.sendStatus === 'failed'}><button type="button" class="inline-flex h-5 w-5 items-center justify-center rounded-full text-[rgb(248,113,113)]" title={t('webimRetrySend') as string} aria-label={t('webimRetrySend') as string} onClick={() => void retryMessage(message)}><CircleX class="h-4 w-4" /></button></Show></span></Show>
            <div class={["min-w-0 rounded-[var(--radius-md)] px-3 py-2 text-[0.88rem] leading-relaxed", message.role === 'user' ? 'bg-[var(--color-accent)]/18 text-[var(--color-text-primary)]' : 'bg-white/6 text-[var(--color-text-primary)]'].join(' ')}><MarkdownMessage preview={markdownPreview()} text={message.text} /><Show when={(message.links?.length ?? 0) > 0}><ul class="mt-2 space-y-1 list-none m-0 p-0"><For each={message.links ?? []}>{(link) => <li><a href={link.url} download="" class="text-[var(--color-accent-soft)] hover:underline text-[0.82rem]">{link.label || link.url}</a></li>}</For></ul></Show></div>
          </div>}</For>
          <Show when={!wsReady() || messages().length === 0}><div class="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 pointer-events-none"><p class="m-0 text-center inline-flex items-center px-4 py-2 rounded-full border text-[0.82rem] font-medium border-[rgba(104,211,145,0.2)] bg-[var(--color-green-dim)] text-[var(--color-green)]">{!wsReady() ? t('webimWsReconnecting') : historyLoading() ? t('webimHistoryLoading') : t('webimEmpty')}</p><Show when={wsReady() && messages().length === 0}><div class="pointer-events-auto flex max-w-2xl flex-wrap justify-center gap-2"><For each={[t('webimQuickPromptPins'), t('webimQuickPromptCurrent'), t('webimQuickPromptLed'), t('webimQuickPromptFile')]}>{(prompt) => <Button size="xs" variant="secondary" onClick={() => setInput(prompt as string)}>{prompt}</Button>}</For></div></Show></div></Show>
        </div>
        <Show when={pendingFiles().length > 0}><div class="flex flex-wrap gap-2 px-4 pb-2"><For each={pendingFiles()}>{(file) => <div class="flex min-w-0 max-w-full items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-black/20 px-2 py-1 text-[0.76rem]"><Show when={file.type.startsWith('image/')} fallback={<FileText class="h-4 w-4 shrink-0 text-[var(--color-accent-soft)]" />}><img src={`/files${file.path}`} alt="" class="h-8 w-8 rounded object-cover" /></Show><span class="max-w-[14rem] truncate">{file.name}</span><span class="text-[var(--color-text-muted)]">{Math.ceil(file.size / 1024)} KB</span><span class={file.status === 'ready' ? 'text-[var(--color-green)]' : file.status === 'failed' ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'}>{file.status === 'ready' ? t('webimAttachmentReady') : file.status === 'failed' ? t('webimAttachmentFailed') : t('webimAttachmentUploading')}</span><button type="button" class="inline-flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-white/10" title={t('webimRemoveAttachment') as string} aria-label={t('webimRemoveAttachment') as string} onClick={() => void removePendingFile(file.path)}><CircleX class="h-4 w-4" /></button></div>}</For></div></Show>
        <div class="p-3 border-t border-[var(--color-border-subtle)] flex flex-col gap-2"><textarea class="w-full min-h-[72px] rounded-[var(--radius-sm)] bg-black/25 border border-[var(--color-border-subtle)] px-3 py-2 text-[0.88rem] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)]" placeholder={t('webimPlaceholder') as string} value={input()} onInput={(event) => setInput(event.currentTarget.value)} onKeyDown={onInputKeyDown} /><div class="flex flex-wrap items-center gap-2">
          <input ref={fileRef} type="file" accept="image/*,.txt,.md,text/plain,text/markdown" class="hidden" onChange={(event) => void onPickFile(event)} />
          <Button size="sm" variant="secondary" type="button" onClick={() => fileRef?.click()} disabled={sending() || !wsReady()}><span class="inline-flex items-center gap-1.5"><ImagePlus class="w-4 h-4" />{t('webimAttach')}</span></Button>
          <Switch class="ml-1" labelClass="text-[var(--color-text-secondary)]" checked={markdownPreview()} disabled={markdownPreviewLoading()} onChange={(checked) => void toggleMarkdownPreview(checked)} label={markdownPreviewLoading() ? (t('webimMarkdownPreviewLoading') as string) : (t('webimMarkdownPreview') as string)} />
          <span class="text-[0.76rem] text-[var(--color-text-muted)] sm:ml-auto">{t('webimSendShortcut')}</span>
          <Button size="sm" variant="primary" onClick={() => void send()} disabled={sending() || !wsReady()}><span class="inline-flex items-center gap-1.5"><SendHorizontal class="w-4 h-4" />{t('webimSend')}</span></Button>
        </div></div>
      </div></div>
    </TabShell>
  );
};
