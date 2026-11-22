/**
 * إدارة هوية التبويب، مزامنة النشاط البشري، حماية تبديل المستخدم، وبث تحديثات المخزون أونلاين بين التبويبات
 * بدون بث أو تخزين رمز الدخول (pos_token) عبر BroadcastChannel.
 */

export const TAB_SYNC_CHANNEL_NAME = 'mudaqqeq_tab_sync_v1';
export const TAB_ID_STORAGE_KEY = 'mudaqqeq_tab_id_v1';
export const LAST_HUMAN_ACTIVITY_STORAGE_KEY = 'mudaqqeq_last_human_activity_v1';
export const SESSION_META_STORAGE_KEY = 'mudaqqeq_auth_session_meta_v1';
export const LEGACY_DRAFT_CLAIM_PREFIX = 'mudaqqeq_legacy_draft_claim_v1_';

export interface BoundSessionIdentity {
  userId: string;
  sessionTag: string;
}

export interface SharedHumanActivityRecord {
  userId: string;
  sessionTag: string;
  at: number;
}

export type TabSyncMessage =
  | { type: 'TAB_HELLO'; tabId: string; instanceId: string; sentAt: number }
  | { type: 'TAB_CLAIMED'; tabId: string; ownerInstanceId: string; sentAt: number }
  | { type: 'USER_ACTIVITY'; userId: string; sessionTag: string; at: number }
  | { type: 'AUTH_LOGOUT'; reason?: string; userId?: string; sessionTag?: string; at: number }
  | { type: 'AUTH_EXPIRED'; message?: string; userId?: string; sessionTag?: string; at: number }
  | { type: 'AUTH_SESSION_CHANGED'; userId: string; sessionTag: string; at: number }
  | {
      type: 'POS_STOCK_UPDATED';
      sourceTabId: string;
      warehouseId?: string;
      itemIds?: string[];
      invoiceNumber?: string;
      at: number;
    }
  | { type: 'OFFLINE_LOCK_RELEASED'; sourceTabId: string; at: number };

const instanceId = (() => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch (_) {}
  return `inst_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
})();

function generateFreshTabId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `tab_${crypto.randomUUID()}`;
    }
  } catch (_) {}
  return `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

let cachedTabId: string | null = null;
let sharedChannel: BroadcastChannel | null = null;
let channelInitialized = false;
const tabIdListeners = new Set<(newTabId: string, prevTabId: string) => void>();
const messageListeners = new Set<(msg: TabSyncMessage) => void>();

export function computeSessionTag(token: string | null | undefined, userId?: string | null): string {
  const raw = `${String(userId || '').trim()}:${String(token || '').trim()}`;
  if (!raw || raw === ':') return '';
  // FNV-1a 64-bit split digest -> non-reversible session tag (never exposes raw token)
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c + ((i + 1) & 0xff);
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `st_${(h1 >>> 0).toString(36)}_${(h2 >>> 0).toString(36)}`;
}

function getBroadcastChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!sharedChannel) {
    try {
      sharedChannel = new BroadcastChannel(TAB_SYNC_CHANNEL_NAME);
    } catch (_) {
      sharedChannel = null;
    }
  }
  return sharedChannel;
}

export function postTabSyncMessage(msg: TabSyncMessage): void {
  const ch = getBroadcastChannel();
  if (!ch) return;
  try {
    ch.postMessage(msg);
  } catch (_) {}
}

export function subscribeTabSyncMessages(listener: (msg: TabSyncMessage) => void): () => void {
  ensureTabSessionInitialized();
  messageListeners.add(listener);
  return () => {
    messageListeners.delete(listener);
  };
}

export function subscribeTabIdChange(
  listener: (newTabId: string, prevTabId: string) => void
): () => void {
  ensureTabSessionInitialized();
  tabIdListeners.add(listener);
  return () => {
    tabIdListeners.delete(listener);
  };
}

function rotateTabIdOnDuplicate(): void {
  const prev = cachedTabId || '';
  const next = generateFreshTabId();
  cachedTabId = next;
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      window.sessionStorage.setItem(TAB_ID_STORAGE_KEY, next);
    }
  } catch (_) {}
  postTabSyncMessage({
    type: 'TAB_HELLO',
    tabId: next,
    instanceId,
    sentAt: Date.now()
  });
  tabIdListeners.forEach((cb) => {
    try {
      cb(next, prev);
    } catch (_) {}
  });
}

function ensureTabSessionInitialized(): void {
  if (channelInitialized || typeof window === 'undefined') return;
  channelInitialized = true;

  if (!cachedTabId) {
    try {
      const existing = window.sessionStorage?.getItem(TAB_ID_STORAGE_KEY)?.trim();
      if (existing) {
        cachedTabId = existing;
      } else {
        cachedTabId = generateFreshTabId();
        window.sessionStorage?.setItem(TAB_ID_STORAGE_KEY, cachedTabId);
      }
    } catch (_) {
      cachedTabId = generateFreshTabId();
    }
  }

  const ch = getBroadcastChannel();
  if (ch) {
    ch.onmessage = (event: MessageEvent<TabSyncMessage>) => {
      const msg = event?.data;
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'TAB_HELLO') {
        if (msg.instanceId !== instanceId && msg.tabId && msg.tabId === cachedTabId) {
          postTabSyncMessage({
            type: 'TAB_CLAIMED',
            tabId: cachedTabId,
            ownerInstanceId: instanceId,
            sentAt: Date.now()
          });
        }
        return;
      }

      if (msg.type === 'TAB_CLAIMED') {
        if (msg.ownerInstanceId !== instanceId && msg.tabId && msg.tabId === cachedTabId) {
          rotateTabIdOnDuplicate();
        }
        return;
      }

      messageListeners.forEach((cb) => {
        try {
          cb(msg);
        } catch (_) {}
      });
    };

    postTabSyncMessage({
      type: 'TAB_HELLO',
      tabId: cachedTabId,
      instanceId,
      sentAt: Date.now()
    });
  }
}

export function getOrInitTabId(): string {
  if (typeof window === 'undefined') {
    if (!cachedTabId) cachedTabId = generateFreshTabId();
    return cachedTabId;
  }
  ensureTabSessionInitialized();
  if (!cachedTabId) {
    cachedTabId = generateFreshTabId();
  }
  return cachedTabId;
}

export function getTabInstanceId(): string {
  return instanceId;
}

export function readSharedHumanActivity(
  identity?: BoundSessionIdentity | null
): number {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return 0;
    const raw = window.localStorage.getItem(LAST_HUMAN_ACTIVITY_STORAGE_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as Partial<SharedHumanActivityRecord>;
    if (!parsed || typeof parsed.at !== 'number' || !Number.isFinite(parsed.at)) return 0;
    if (identity?.sessionTag && parsed.sessionTag && parsed.sessionTag !== identity.sessionTag) {
      return 0;
    }
    if (identity?.userId && parsed.userId && parsed.userId !== identity.userId) {
      return 0;
    }
    return parsed.at;
  } catch {
    return 0;
  }
}

export function writeSharedHumanActivity(
  at: number,
  identity?: BoundSessionIdentity | null
): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    const record: SharedHumanActivityRecord = {
      userId: identity?.userId || '',
      sessionTag: identity?.sessionTag || '',
      at
    };
    window.localStorage.setItem(LAST_HUMAN_ACTIVITY_STORAGE_KEY, JSON.stringify(record));
  } catch (_) {}
}

export function writeSessionMeta(identity: BoundSessionIdentity | null): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (!identity || !identity.userId || !identity.sessionTag) {
      window.localStorage.removeItem(SESSION_META_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(SESSION_META_STORAGE_KEY, JSON.stringify(identity));
  } catch (_) {}
}

export function readSessionMeta(): BoundSessionIdentity | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const raw = window.localStorage.getItem(SESSION_META_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BoundSessionIdentity>;
    if (!parsed?.userId || !parsed?.sessionTag) return null;
    return {
      userId: String(parsed.userId),
      sessionTag: String(parsed.sessionTag)
    };
  } catch {
    return null;
  }
}

export function clearSharedHumanActivity(): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem(LAST_HUMAN_ACTIVITY_STORAGE_KEY);
    }
  } catch (_) {}
}

/**
 * تحديد ما إذا كان يجب على هذا التبويب المطالبة بعرض المسودة القديمة المشتركة (بدون tabId) مرة واحدة فقط
 * حتى لا تعرض عدة تبويبات نفس المسودة القديمة في آن واحد أو تحذفها قبل استكمالها.
 */
export async function tryClaimLegacyPosDraftPrompt(
  userKey: string,
  tabId: string
): Promise<boolean> {
  if (typeof window === 'undefined' || !window.localStorage) return false;
  const claimKey = `${LEGACY_DRAFT_CLAIM_PREFIX}${userKey}`;
  const attemptClaim = (): boolean => {
    try {
      const existingRaw = window.localStorage.getItem(claimKey);
      if (existingRaw) {
        const parsed = JSON.parse(existingRaw) as { tabId?: string; claimedAt?: number };
        if (parsed?.tabId === tabId) return true;
        // التبويب الذي طالب بها ما زال حديثاً (أقل من 12 ساعة)
        if (parsed?.claimedAt && Date.now() - parsed.claimedAt < 12 * 60 * 60 * 1000) {
          return false;
        }
      }
      window.localStorage.setItem(
        claimKey,
        JSON.stringify({ tabId, claimedAt: Date.now() })
      );
      return true;
    } catch {
      return false;
    }
  };

  if (typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function') {
    try {
      return await navigator.locks.request(
        `mudaqqeq_legacy_draft_lock_${userKey}`,
        { mode: 'exclusive' },
        async () => attemptClaim()
      );
    } catch {
      return false;
    }
  }
  return attemptClaim();
}

export function clearLegacyDraftClaim(userKey: string): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem(`${LEGACY_DRAFT_CLAIM_PREFIX}${userKey}`);
    }
  } catch (_) {}
}
