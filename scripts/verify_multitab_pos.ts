/**
 * اختبار التبويبات المتعددة ونقطة البيع المستقلة أونلاين + القفل الذري للأوفلاين
 * التشغيل: npx tsx scripts/verify_multitab_pos.ts
 * بدون اتصال بـ Supabase الحي أو خادم خارجي.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getHrefForTarget,
  getHrefForItemRoute,
  resolvePathToTarget,
  isPlainLeftClick,
  normalizeNavigationTarget,
  isSubItemVisible,
  ALL_NAV_SUB_ITEMS,
} from '../src/config/navigation.ts';
import {
  computeSessionTag,
  tryClaimLegacyPosDraftPrompt,
  clearLegacyDraftClaim,
  readSharedHumanActivity,
  writeSharedHumanActivity,
  clearSharedHumanActivity,
  LAST_HUMAN_ACTIVITY_STORAGE_KEY,
  TAB_ID_STORAGE_KEY,
  getOrInitTabId,
  subscribeTabIdChange,
} from '../src/utils/tabSession.ts';
import {
  setBoundSessionIdentity,
  setOnSessionMismatch,
  assertBoundSessionMatches,
  recordUserInteraction,
  getLastUserInteractionAt,
  setAuthToken,
  api,
} from '../src/api/client.ts';
import { CartJournalClient, type JournalStorage, type JournalEvent } from '../src/offline/cartJournal.ts';
import {
  acquireOfflineLock,
  releaseOfflineLock,
  hasOfflineLockOwnership,
  assertOfflineWriteOwnership,
  getOfflineLockSnapshot,
  __setOfflineLockAdapterForTests,
} from '../src/offline/offlineLock.ts';
import {
  createOfflineInvoiceInDb,
  createOfflineCreditCollectionInDb,
  syncOutboxOperations,
} from '../src/offline/db.ts';
import { ALL_PERMISSIONS } from '../src/utils/permissions.ts';
import type { UserAccount } from '../src/types.ts';

let passed = 0;
function check(name: string, condition: unknown, details?: string) {
  if (!condition) {
    throw new Error(`فشل التحقق (${name})${details ? `: ${details}` : ''}`);
  }
  passed++;
  console.log(`  ✅ PASS: ${name}`);
}

function makeMemoryStorage(): Storage & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
}

function makeJournalStorage(): JournalStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => {
      data.set(k, v);
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
}

const fullUser: UserAccount = {
  id: 'u-admin-1',
  name: 'مدير النظام',
  username: 'admin',
  phone: '01000000001',
  role: 'designer',
  permissions: [...ALL_PERMISSIONS],
  status: 'نشط',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const cashierDirectOnly: UserAccount = {
  id: 'u-cashier-2',
  name: 'كاشير مبيعات',
  username: 'cashier2',
  phone: '01000000002',
  role: 'cashier',
  permissions: ['pos.sell', 'invoices.view'],
  status: 'نشط',
  createdAt: '2026-01-01T00:00:00.000Z',
};

async function testNavigationAndRoutes() {
  console.log('\n1) اختبار المسارات المعتمدة وبناء روابط href وتوافق المودز والصلاحيات');

  check('رابط لوحة التحكم الأساسي', getHrefForTarget('dashboard') === '/dashboard');
  check('رابط نقطة البيع', getHrefForTarget('pos') === '/pos');
  check('رابط تبويب مزامنة الأوفلاين الفاشلة', getHrefForTarget('sync', 'failed') === '/sync/failed');
  check('رابط كشف حساب العملاء', getHrefForTarget('customers', 'STATEMENT') === '/customers/statement');
  check(
    'رابط سياقي لمعرف المورد',
    getHrefForTarget('purchases', 'STATEMENT', { searchParams: { supplierId: 'sup-7' } }) ===
      '/purchases/statement?supplierId=sup-7'
  );
  check(
    'رابط سياقي لمعرف العميل والبحث',
    getHrefForTarget('customers', 'CREDIT_COLLECTION', { searchParams: { customerId: 'cust-9' } }) ===
      '/customers/credit-collection?customerId=cust-9'
  );
  check(
    'رابط سياقي لمعرف الخزينة',
    getHrefForTarget('cashboxes', 'TRANSACTIONS', { searchParams: { cashboxId: 'cb-4' } }) ===
      '/cashboxes/transactions?cashboxId=cb-4'
  );
  check(
    'رابط سياقي لتصنيف الأصناف',
    getHrefForTarget('items', undefined, { searchParams: { category: 'cat-12' } }) ===
      '/items?category=cat-12'
  );
  check(
    'رابط استيراد الأصناف بإكسل',
    getHrefForTarget('bulk_edit_excel', 'add_items', { searchParams: { operationType: 'add_items' } }) ===
      '/items/bulk-edit?operationType=add_items'
  );
  check('رابط صنف جديد', getHrefForItemRoute('new') === '/items/new');
  check('رابط تعديل صنف مع encodeURIComponent', getHrefForItemRoute('edit', 'item/a 1') === '/items/item%2Fa%201');

  const rNewItem = resolvePathToTarget('/items/new', fullUser);
  check(
    'تحليل مسار /items/new يفتح شاشة صنف جديد',
    rNewItem.page === 'items' && rNewItem.itemRoute?.mode === 'new' && !rNewItem.redirected
  );

  const rEditItem = resolvePathToTarget('/items/it-99?search=test', fullUser);
  check(
    'تحليل مسار /items/:id يفتح تعديل الصنف',
    rEditItem.page === 'items' && rEditItem.itemRoute?.mode === 'edit' && rEditItem.itemRoute.itemId === 'it-99'
  );

  const rBackupSection = resolvePathToTarget('/settings?section=backup', fullUser);
  check(
    'تحليل /settings?section=backup يحول إلى /settings/integration#backup',
    rBackupSection.page === 'settings' &&
      rBackupSection.tab === 'integration' &&
      rBackupSection.hash === '#backup' &&
      rBackupSection.path === '/settings/integration#backup'
  );

  const rSalesSection = resolvePathToTarget('/settings?section=sales', fullUser);
  check(
    'تحليل /settings?section=sales يفتح تبويب المبيعات',
    rSalesSection.page === 'settings' && rSalesSection.tab === 'sales' && rSalesSection.path === '/settings/sales'
  );

  const rPlatformDisabled = resolvePathToTarget('/platforms', fullUser, {
    platformsEnabled: false,
    salesOnlyMode: false,
  });
  check(
    'تعطيل المنصات يمنع فتح /platforms ويوجه لمسار مسموح',
    rPlatformDisabled.redirected && rPlatformDisabled.page !== 'platforms'
  );

  const rSalesOnly = resolvePathToTarget('/dashboard', fullUser, {
    platformsEnabled: true,
    salesOnlyMode: true,
  });
  check(
    'وضع البيع فقط يوجّه /dashboard تلقائياً إلى /pos',
    rSalesOnly.redirected && rSalesOnly.page === 'pos' && rSalesOnly.path === '/pos'
  );

  const usersNavItem = ALL_NAV_SUB_ITEMS.find((s) => s.path === '/settings/users')!;
  const normCashier = normalizeNavigationTarget('settings', 'users', cashierDirectOnly);
  const normBnplOff = normalizeNavigationTarget('reports', 'BNPL', fullUser, {
    platformsEnabled: false,
    salesOnlyMode: false,
  });
  check(
    'الصلاحيات المحدودة وقيود المنصات تمنع المسارات غير المصرح بها وتوجّه للمسار المسموح',
    isSubItemVisible(usersNavItem, cashierDirectOnly) === false &&
      normCashier.path !== '/settings/users' &&
      normBnplOff.tab === 'FINANCIAL'
  );

  check(
    'isPlainLeftClick تسمح بالنقرة اليسرى العادية وتترك Ctrl/Cmd/Shift/Middle للمتصفح',
    isPlainLeftClick({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }) === true &&
      isPlainLeftClick({ button: 0, metaKey: false, ctrlKey: true, shiftKey: false, altKey: false }) === false &&
      isPlainLeftClick({ button: 0, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }) === false &&
      isPlainLeftClick({ button: 1, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }) === false
  );

  // التحقق الساكن من ربط الروابط الداخلية الحقيقية <a href> دون المساس بـ /visitor و MUDAQQEQ_BRAND_URL
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const expectedLinkedFiles = [
    'src/components/Sidebar.tsx',
    'src/components/Navbar.tsx',
    'src/components/MobileBottomNav.tsx',
    'src/components/settings/SettingsSectionNav.tsx',
    'src/pages/DashboardPage.tsx',
    'src/components/DashboardAurora.tsx',
    'src/pages/ProductsPage.tsx',
    'src/pages/ProductFormPage.tsx',
    'src/pages/CategoriesPage.tsx',
    'src/pages/WarehouseTransferPage.tsx',
    'src/pages/WarehouseExcelTransferPage.tsx',
    'src/pages/WarehouseDispatchOrdersPage.tsx',
    'src/pages/InvoicesPage.tsx',
    'src/pages/PurchasesPage.tsx',
    'src/pages/CustomersPage.tsx',
    'src/pages/CashboxesPage.tsx',
    'src/pages/PlatformsPage.tsx',
    'src/pages/POSPage.tsx',
    'src/components/pos/PosProductGrid.tsx',
    'src/components/ItemImportModal.tsx',
  ];
  for (const rel of expectedLinkedFiles) {
    const content = fs.readFileSync(path.join(rootDir, rel), 'utf8');
    check(
      `الملف ${rel} يستخدم href حقيقي عبر getHrefForTarget أو getHrefForItemRoute`,
      content.includes('href={') &&
        (content.includes('getHrefForTarget') || content.includes('getHrefForItemRoute'))
    );
  }
  const brandSrc = fs.readFileSync(path.join(rootDir, 'src/config/brand.ts'), 'utf8');
  check('MUDAQQEQ_BRAND_URL محفوظ كما هو دون تعديل', brandSrc.includes("https://modaqqeq.com"));
  const appSrc = fs.readFileSync(path.join(rootDir, 'src/App.tsx'), 'utf8');
  check('/visitor لا يزال معزولاً في App.tsx', appSrc.includes("currentPage === 'visitor'"));
}

async function testPosPerTabIsolationAndLegacyClaim() {
  console.log('\n2) اختبار عزل مسودات وسلة كل تبويب + استعادة المسودة القديمة مرة واحدة + تدوير tabId عند نسخ التبويب');

  const localStore = makeMemoryStorage();
  const sessionStore = makeMemoryStorage();
  const prevWin = (globalThis as any).window;
  const prevLs = (globalThis as any).localStorage;
  const prevNav = (globalThis as any).navigator;
  const prevBc = (globalThis as any).BroadcastChannel;

  const sentMessages: any[] = [];
  const activeChannels: MockBroadcastChannel[] = [];
  class MockBroadcastChannel {
    name: string;
    onmessage: ((ev: { data: any }) => void) | null = null;
    constructor(name: string) {
      this.name = name;
      activeChannels.push(this);
    }
    postMessage(msg: any) {
      sentMessages.push(msg);
    }
    close() {}
  }

  try {
    const fakeWindow: any = {
      localStorage: localStore,
      sessionStorage: sessionStore,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    (globalThis as any).window = fakeWindow;
    (globalThis as any).localStorage = localStore;
    (globalThis as any).BroadcastChannel = MockBroadcastChannel;
    // حذف navigator.locks مؤقتاً لهذا الاختبار ليستخدم مسار tryClaimLegacyPosDraftPrompt المحلي النظيف
    (globalThis as any).navigator = {};

    // تدوير tabId إذا ادعى تبويب آخر ملكيته (محاكاة Duplicate Tab في المتصفح)
    const tabIdInitial = getOrInitTabId();
    let rotatedTo = '';
    const unsubRotate = subscribeTabIdChange((nextId) => {
      rotatedTo = nextId;
    });
    const helloMsg = sentMessages.find((m) => m.type === 'TAB_HELLO');
    check('بث TAB_HELLO عند تهيئة التبويب الأول', Boolean(helloMsg && helloMsg.tabId === tabIdInitial));
    // محاكاة تبويب أصلي يرد بـ TAB_CLAIMED على نفس tabId عند نسخ التبويب
    activeChannels.forEach((ch) => {
      ch.onmessage?.({
        data: {
          type: 'TAB_CLAIMED',
          tabId: tabIdInitial,
          ownerInstanceId: 'other-original-tab-instance',
          sentAt: Date.now(),
        },
      });
    });
    unsubRotate();
    check(
      'استقبال TAB_CLAIMED لنفس tabId يدوّر معرف التبويب تلقائياً ويحفظه في sessionStorage',
      Boolean(rotatedTo) &&
        rotatedTo !== tabIdInitial &&
        sessionStore.getItem(TAB_ID_STORAGE_KEY) === rotatedTo
    );

    // اختبار مفاتيح المسودات المعزولة لكل تبويب مطابقة لما في POSPage
    const keyTab1 = `pos_open_invoice_draft_u-1__tab_tabA`;
    const keyTab2 = `pos_open_invoice_draft_u-1__tab_tabB`;
    localStore.setItem(keyTab1, JSON.stringify({ cart: [{ itemId: 'p1', quantity: 2 }] }));
    localStore.setItem(keyTab2, JSON.stringify({ cart: [{ itemId: 'p2', quantity: 5 }] }));
    check('مسودة التبويب الأول مستقلة عن التبويب الثاني', keyTab1 !== keyTab2 && localStore.getItem(keyTab1) !== localStore.getItem(keyTab2));

    // اختبار المطالبة بالمسودة القديمة المشتركة (بدون __tab_) مرة واحدة فقط
    const claimed1 = await tryClaimLegacyPosDraftPrompt('u-1', 'tabA');
    const claimed2 = await tryClaimLegacyPosDraftPrompt('u-1', 'tabB');
    const claimed1Again = await tryClaimLegacyPosDraftPrompt('u-1', 'tabA');
    check('أول تبويب يطالب بالمسودة القديمة بنجاح', claimed1 === true);
    check('التبويب الثاني لا يكرر نافذة استعادة نفس المسودة القديمة', claimed2 === false);
    check('نفس التبويب المالك يحتفظ بحق المطالبة حتى الحسم', claimed1Again === true);
    clearLegacyDraftClaim('u-1');
    const claimedAfterClear = await tryClaimLegacyPosDraftPrompt('u-1', 'tabB');
    check('بعد إزالة المطالبة يمكن المطالبة مجدداً عند الحاجة', claimedAfterClear === true);

    // عزل cartId في CartJournalClient لكل تبويب على نفس journal storage
    const sharedJournalStorage = makeJournalStorage();
    const cjTab1 = new CartJournalClient({
      storage: sharedJournalStorage,
      ownerTabId: 'tabAlpha',
      autoTimers: false,
      send: async () => ({ lastSeq: 1 }),
    });
    const cjTab2 = new CartJournalClient({
      storage: sharedJournalStorage,
      ownerTabId: 'tabBeta',
      autoTimers: false,
      send: async () => ({ lastSeq: 2 }),
    });
    check(
      'كل تبويب يحصل على cartId خاص ومختلف مع ownerTabId',
      cjTab1.currentCartId() !== cjTab2.currentCartId() &&
        cjTab1.currentCartId().includes('Alpha') &&
        cjTab2.currentCartId().includes('Beta')
    );

    // تدوير tabId داخل CartJournalClient مع بقاء الأصناف المفتوحة
    const beforeRotateCartId = cjTab1.currentCartId();
    cjTab1.syncCart([{ itemId: 'item-1', name: 'قلم', unitPrice: 15, quantity: 3 }]);
    cjTab1.setOwnerTabId('tabGamma');
    check(
      'تغيير ownerTabId يدوّر cartId مع الاحتفاظ بأصناف الفاتورة المفتوحة',
      cjTab1.currentCartId() !== beforeRotateCartId &&
        cjTab1.currentCartId().includes('Gamma') &&
        cjTab1.pendingCount() >= 2
    );
    void rotatedTo;
  } finally {
    (globalThis as any).window = prevWin;
    (globalThis as any).localStorage = prevLs;
    (globalThis as any).navigator = prevNav;
    (globalThis as any).BroadcastChannel = prevBc;
  }
}

async function testSessionBindingActivityAndSwitchGuard() {
  console.log('\n3) اختبار ربط الجلسة، مزامنة النشاط البشري، عدم تسريب التوكن، وحماية تبديل المستخدم');

  const localStore = makeMemoryStorage();
  const prevWin = (globalThis as any).window;
  const prevLs = (globalThis as any).localStorage;
  const prevFetch = (globalThis as any).fetch;
  const prevNav = (globalThis as any).navigator;

  try {
    (globalThis as any).window = {
      localStorage: localStore,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    (globalThis as any).localStorage = localStore;
    (globalThis as any).navigator = { onLine: true, userAgent: 'Chrome Windows' };

    const rawSecretToken = 'tok_super_secret_do_not_leak_987654';
    const tag1 = computeSessionTag(rawSecretToken, 'usr-1');
    check(
      'computeSessionTag لا يحتوي على رمز الدخول الخام (pos_token)',
      Boolean(tag1) && !tag1.includes('tok_super_secret') && !tag1.includes('987654')
    );

    localStore.setItem('pos_token', rawSecretToken);
    localStore.setItem('pos_user', JSON.stringify({ id: 'usr-1', username: 'ahmed' }));
    setBoundSessionIdentity({ userId: 'usr-1', sessionTag: tag1 });

    // اختبار النشاط المشترك بين التبويبات: التفاعل البشري يحدّث، واستطلاع الخلفية يرسل X-Background-Poll=1
    clearSharedHumanActivity();
    const olderAt = Date.now() - 120_000;
    writeSharedHumanActivity(olderAt, { userId: 'usr-1', sessionTag: tag1 });
    recordUserInteraction();
    const afterInteraction = readSharedHumanActivity({ userId: 'usr-1', sessionTag: tag1 });
    check('التفاعل البشري يحدّث الطابع الزمني المشترك في localStorage', afterInteraction > olderAt && getLastUserInteractionAt() >= afterInteraction);

    const capturedHeaders: Record<string, string>[] = [];
    (globalThis as any).fetch = async (_url: string, init: RequestInit) => {
      capturedHeaders.push((init?.headers as Record<string, string>) || {});
      return new Response(JSON.stringify({ success: true, user: { id: 'usr-1', name: 'Ahmed', username: 'ahmed' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    await api.getMe({ background: true });
    check(
      'طلبات الخلفية الدورية تحمل X-Background-Poll=1 و X-User-Activity=0 ولا تُحسب نشاطاً بشرياً',
      capturedHeaders.length === 1 &&
        capturedHeaders[0]['X-Background-Poll'] === '1' &&
        capturedHeaders[0]['X-User-Activity'] === '0'
    );

    // التأكد من حماية تبديل المستخدم: إذا تغير المستخدم أو التوكن في تبويب آخر يُمنع هذا التبويب من الإرسال ولا يحذف التوكن الأحدث
    let mismatchMsg = '';
    setOnSessionMismatch((msg) => {
      mismatchMsg = msg;
    });

    const newerUserToken = 'tok_user2_brand_new';
    setAuthToken(newerUserToken);
    localStore.setItem('pos_user', JSON.stringify({ id: 'usr-2', username: 'sara' }));

    let blockedByMismatch = false;
    try {
      assertBoundSessionMatches();
    } catch (err: any) {
      blockedByMismatch = err?.code === 'SESSION_MISMATCH' && err?.status === 401;
    }

    check('تبديل الحساب في تبويب آخر يوقف الطلبات في التبويب القديم برمز SESSION_MISMATCH', blockedByMismatch);
    check('إشعار sessionMismatchHandler استُدعي برسالة عربية واضحة', mismatchMsg.includes('تبديل'));
    check('رمز الجلسة الأحدث pos_token لم يُحذف من localStorage عند رفض التبويب القديم', localStore.getItem('pos_token') === newerUserToken);
  } finally {
    setBoundSessionIdentity(null);
    setOnSessionMismatch(null);
    (globalThis as any).window = prevWin;
    (globalThis as any).localStorage = prevLs;
    (globalThis as any).fetch = prevFetch;
    (globalThis as any).navigator = prevNav;
  }
}

async function testCartJournalConcurrentFlushSerialization() {
  console.log('\n4) اختبار تسلسل رفع CartJournal عبر التبويبات ومنع فقد الأحداث المتزامنة');

  const prevNav = (globalThis as any).navigator;
  let activeLockCount = 0;
  let maxConcurrentLocks = 0;
  let lockTail = Promise.resolve();

  try {
    (globalThis as any).navigator = {
      locks: {
        request: (_name: string, _opts: any, cb: (lock: any) => Promise<any>) => {
          const next = lockTail.then(async () => {
            activeLockCount++;
            maxConcurrentLocks = Math.max(maxConcurrentLocks, activeLockCount);
            try {
              return await cb({ name: _name });
            } finally {
              activeLockCount--;
            }
          });
          lockTail = next.catch(() => undefined);
          return next;
        },
      },
    };

    const sharedStorage = makeJournalStorage();
    const deliveredEvents: JournalEvent[] = [];
    let sendCalls = 0;
    let firstSendStartedResolve!: () => void;
    let releaseFirstSend!: () => void;
    const firstSendStarted = new Promise<void>((r) => {
      firstSendStartedResolve = r;
    });
    const firstSendGate = new Promise<void>((r) => {
      releaseFirstSend = r;
    });

    const makeClient = (ownerTabId: string) =>
      new CartJournalClient({
        storage: sharedStorage,
        ownerTabId,
        autoTimers: false,
        send: async ({ events }) => {
          sendCalls++;
          if (sendCalls === 1) {
            firstSendStartedResolve();
            await firstSendGate;
          }
          for (const ev of events) {
            deliveredEvents.push(ev);
          }
          const lastSeq = events.reduce((m, e) => (e.seq > m ? e.seq : m), 0);
          return { lastSeq };
        },
      });

    const clientA = makeClient('tabOne');
    const clientB = makeClient('tabTwo');

    clientA.syncCart([{ itemId: 'it-1', name: 'صنف 1', unitPrice: 10, quantity: 1 }]);
    const flushA = clientA.flush();
    await firstSendStarted;

    // أثناء إرسال الدفعة الأولى: تبويب B يضيف حدثاً جديداً ويطلب flush متزامناً
    clientB.syncCart([{ itemId: 'it-2', name: 'صنف 2', unitPrice: 20, quantity: 2 }]);
    const flushB = clientB.flush();

    releaseFirstSend();
    await Promise.all([flushA, flushB]);

    check('قفل Web Locks منع تداخل عمليات flush (الحد الأقصى للتنفيذ المتوازي = 1)', maxConcurrentLocks === 1);
    const deliveredItemIds = new Set(deliveredEvents.map((e) => e.itemId).filter(Boolean));
    check(
      'الأحداث المضافة من تبويب B أثناء رفع تبويب A لم تُفقد وتملك أرقام seq متفردة',
      deliveredItemIds.has('it-1') &&
        deliveredItemIds.has('it-2') &&
        new Set(deliveredEvents.map((e) => e.seq)).size === deliveredEvents.length &&
        clientA.pendingCount() === 0 &&
        clientB.pendingCount() === 0
    );
  } finally {
    (globalThis as any).navigator = prevNav;
  }
}

async function testOfflineSingleTabLockFailClosed() {
  console.log('\n5) اختبار القفل الذري الصارم للعمل أوفلاين (تبويب واحد فقط + Fail-Closed)');

  try {
    // الحالة أ: المتصفح لا يدعم Web Locks API -> إغلاق آمن Fail-Closed
    __setOfflineLockAdapterForTests({
      isBrowserRuntime: () => true,
      hasWebLocks: () => false,
      requestExclusiveLockIfAvailable: async () => true,
    });
    const unsupportedSnap = await acquireOfflineLock();
    check(
      'عدم توفر Web Locks في المتصفح يعطي unsupported و hasOwnership=false',
      unsupportedSnap.status === 'unsupported' &&
        unsupportedSnap.hasOwnership === false &&
        hasOfflineLockOwnership() === false
    );

    let unsupportedBlockedMsg = '';
    try {
      await assertOfflineWriteOwnership();
    } catch (err: any) {
      unsupportedBlockedMsg = err?.message || '';
    }
    check('assertOfflineWriteOwnership يرفض الكتابة عند عدم دعم Web Locks برسالة عربية', /[\u0600-\u06FF]/.test(unsupportedBlockedMsg));

    // الحالة ب: تبويب آخر يمتلك القفل بالفعل (held_by_other)
    let lockHeldExternally = true;
    __setOfflineLockAdapterForTests({
      isBrowserRuntime: () => true,
      hasWebLocks: () => true,
      requestExclusiveLockIfAvailable: async (_name, onAcquired) => {
        if (lockHeldExternally) return false;
        void onAcquired();
        return true;
      },
    });

    const blockedSnap = await acquireOfflineLock();
    check(
      'عندما يكون القفل مملوكاً لتبويب آخر يرجع held_by_other و hasOwnership=false',
      blockedSnap.status === 'held_by_other' &&
        blockedSnap.hasOwnership === false &&
        getOfflineLockSnapshot().status === 'held_by_other'
    );

    let invoiceBlocked = false;
    try {
      await createOfflineInvoiceInDb({
        invoicePayload: { paymentType: 'نقدي', lines: [] },
        user: fullUser,
      });
    } catch (err: any) {
      invoiceBlocked = Boolean(err?.message && /تبويب واحد/.test(err.message));
    }
    check('createOfflineInvoiceInDb يُمنع تلقائياً دون لمس IndexedDB عندما القفل لتبويب آخر', invoiceBlocked);

    let collectionBlocked = false;
    try {
      await createOfflineCreditCollectionInDb({
        payload: {
          partyType: 'customer',
          partyId: 'c1',
          cashboxId: 'cb1',
          invoiceNumbers: ['INV-1'],
          receivedAmount: 100,
        },
        user: fullUser,
      });
    } catch (err: any) {
      collectionBlocked = Boolean(err?.message && /تبويب واحد/.test(err.message));
    }
    check('createOfflineCreditCollectionInDb يُمنع تلقائياً عندما القفل لتبويب آخر', collectionBlocked);

    let syncBlocked = false;
    try {
      await syncOutboxOperations({
        user: fullUser,
        syncFn: async () => ({ success: true }),
      });
    } catch (err: any) {
      syncBlocked = Boolean(err?.message && /تبويب واحد/.test(err.message));
    }
    check('syncOutboxOperations يُمنع تلقائياً عندما القفل لتبويب آخر', syncBlocked);

    // الحالة ج: بعد تحرير التبويب الأول للقفل، يكتسب هذا التبويب القفل بنجاح
    lockHeldExternally = false;
    const acquiredSnap = await acquireOfflineLock();
    check(
      'بعد إغلاق/تحرير التبويب المالك ينجح التبويب التالي في اكتساب القفل',
      acquiredSnap.status === 'acquired' && acquiredSnap.hasOwnership === true && hasOfflineLockOwnership() === true
    );
    await assertOfflineWriteOwnership();
    check('assertOfflineWriteOwnership يمر بسلام بعد امتلاك القفل', true);
    releaseOfflineLock();
  } finally {
    __setOfflineLockAdapterForTests(null);
  }
}

async function main() {
  console.log('================================================================');
  console.log('التحقق الشامل لمعمارية التبويبات المتعددة و POS المستقل أونلاين');
  console.log('================================================================');

  await testNavigationAndRoutes();
  await testPosPerTabIsolationAndLegacyClaim();
  await testSessionBindingActivityAndSwitchGuard();
  await testCartJournalConcurrentFlushSerialization();
  await testOfflineSingleTabLockFailClosed();

  console.log(`\n🎉 نجحت جميع اختبارات التبويبات المتعددة والـ POS المستقل (${passed} تحققاً).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌', err?.stack || err?.message || err);
    process.exit(1);
  });
