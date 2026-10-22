import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js';
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile
} from 'https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  setDoc
} from 'https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyD1g75kSAMq9ku5VlYMH-h6z64ZhPgtK50',
  authDomain: 'ledgerix-e7870.firebaseapp.com',
  projectId: 'ledgerix-e7870',
  storageBucket: 'ledgerix-e7870.firebasestorage.app',
  messagingSenderId: '889932132306',
  appId: '1:889932132306:web:859d0d6fe55e1bf631e20b',
  measurementId: 'G-Y7WPKVG2MG'
};
const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const STORAGE_KEY = 'ledgerix-web-v1';
const currencies = ['Rp', '$', '€', '£', '¥'];
const icons = { overview: 'account_balance_wallet', invoices: 'receipt_long', inventory: 'inventory_2', analytics: 'insights', settings: 'settings' };
const initialState = {
  profile: { name: '', address: '', taxId: '', bankDetails: '', paypalEmail: '', invoicePrefix: 'INV', invoiceCounter: 1, currency: 'Rp' },
  invoices: [],
  inventory: [],
  expenses: []
};

function loadState(userId) {
  try {
    let serialized = localStorage.getItem(`${STORAGE_KEY}:${userId}`);
    if (!serialized && localStorage.getItem(`${STORAGE_KEY}:legacy-migrated`) !== 'true') {
      serialized = localStorage.getItem(STORAGE_KEY);
      localStorage.setItem(`${STORAGE_KEY}:legacy-migrated`, 'true');
    }
    const saved = JSON.parse(serialized);
    return saved ? { ...initialState, ...saved, profile: { ...initialState.profile, ...saved.profile } } : structuredClone(initialState);
  } catch {
    return structuredClone(initialState);
  }
}

let state = structuredClone(initialState);
let currentPage = 'overview';
let inventoryTab = 'stock';
let searchTerm = '';
let activeInvoiceId = null;
let toastTimer;
let currentUser = null;
let authMode = 'signin';
let syncQueue = Promise.resolve();
let syncRevision = 0;

function saveState() {
  if (!currentUser) return;
  const userId = currentUser.uid;
  const snapshot = structuredClone(state);
  const revision = ++syncRevision;
  localStorage.setItem(`${STORAGE_KEY}:${userId}`, JSON.stringify(snapshot));
  syncQueue = syncQueue
    .then(() => syncStateToFirestore(userId, snapshot))
    .then(() => {
      if (revision === syncRevision) showToast('All changes saved to Firestore.');
    })
    .catch(error => {
      console.error('Ledgerix cloud sync failed:', error);
      showToast('Cloud save failed. Your changes are cached here; check your Firebase connection and rules.');
    });
}

function cloudDate(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  return match ? `${match[3]}-${match[2]}-${match[1]}` : date;
}

function browserDate(date) {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(date || '');
  return match ? `${match[3]}-${match[2]}-${match[1]}` : date;
}

function hasLocalData(value) {
  return value.invoices.length > 0 || value.inventory.length > 0 || value.expenses.length > 0 || Boolean(value.profile.name || value.profile.address);
}

async function syncStateToFirestore(userId, snapshot) {
  const userRef = doc(db, 'users', userId);
  await setDoc(userRef, {
    name: snapshot.profile.name,
    address: snapshot.profile.address,
    taxId: snapshot.profile.taxId,
    bankDetails: snapshot.profile.bankDetails,
    paypalEmail: snapshot.profile.paypalEmail,
    invoicePrefix: snapshot.profile.invoicePrefix,
    invoiceCounter: snapshot.profile.invoiceCounter,
    currency: snapshot.profile.currency
  }, { merge: true });

  await Promise.all(snapshot.invoices.map(invoice => setDoc(
    doc(db, 'users', userId, 'invoices', invoice.invoiceNo),
    {
      invoiceNo: invoice.invoiceNo,
      date: cloudDate(invoice.date),
      customerName: invoice.customerName,
      totalAmount: invoiceTotal(invoice),
      amountPaid: Number(invoice.amountPaid) || 0,
      isPaid: Number(invoice.amountPaid) >= invoiceTotal(invoice),
      totalDiscountPct: Number(invoice.totalDiscountPct) || 0,
      totalDiscountIsAmt: Boolean(invoice.totalDiscountIsAmt),
      currency: invoice.currency,
      notes: invoice.notes || '',
      showPaidStamp: Boolean(invoice.showPaidStamp),
      showSignature: Boolean(invoice.showSignature),
      items: invoice.items.map(item => ({
        productName: item.name,
        qty: Number(item.qty) || 1,
        rate: Number(item.rate) || 0,
        discountPct: Number(item.discountPct) || 0,
        discountIsAmt: Boolean(item.discountIsAmt)
      }))
    },
    { merge: true }
  )));

  await Promise.all(snapshot.inventory.map(item => setDoc(
    doc(db, 'users', userId, 'stock', item.name),
    { itemName: item.name, lastPrice: Number(item.price) || 0, stock: Number(item.stock) || 0 },
    { merge: true }
  )));

  await Promise.all(snapshot.expenses.map(expense => setDoc(
    doc(db, 'users', userId, 'expenses', expense.id),
    {
      description: expense.description,
      amount: Number(expense.amount) || 0,
      category: expense.category || 'General',
      date: Number(expense.date) || Date.now(),
      isCogs: Number(expense.isCogs) || 0
    },
    { merge: true }
  )));
}

async function loadCloudState(userId) {
  const userRef = doc(db, 'users', userId);
  const [profileSnapshot, invoiceSnapshot, stockSnapshot, expenseSnapshot] = await Promise.all([
    getDoc(userRef),
    getDocs(collection(db, 'users', userId, 'invoices')),
    getDocs(collection(db, 'users', userId, 'stock')),
    getDocs(collection(db, 'users', userId, 'expenses'))
  ]);

  const cached = loadState(userId);
  if (!profileSnapshot.exists() && invoiceSnapshot.empty && stockSnapshot.empty && expenseSnapshot.empty) {
    state = cached;
    if (hasLocalData(cached)) await syncStateToFirestore(userId, cached);
    return;
  }

  const profile = profileSnapshot.data() || {};
  state = {
    profile: {
      ...initialState.profile,
      name: profile.name || '',
      address: profile.address || '',
      taxId: profile.taxId || '',
      bankDetails: profile.bankDetails || '',
      paypalEmail: profile.paypalEmail || '',
      invoicePrefix: profile.invoicePrefix || 'INV',
      invoiceCounter: Number(profile.invoiceCounter) || invoiceSnapshot.size + 1,
      currency: profile.currency || 'Rp'
    },
    invoices: invoiceSnapshot.docs.map(invoiceDoc => {
      const data = invoiceDoc.data();
      return {
        id: invoiceDoc.id,
        invoiceNo: data.invoiceNo || invoiceDoc.id,
        date: browserDate(data.date || ''),
        customerName: data.customerName || '',
        totalAmount: Number(data.totalAmount) || 0,
        amountPaid: Number(data.amountPaid) || 0,
        totalDiscountPct: Number(data.totalDiscountPct) || 0,
        totalDiscountIsAmt: Boolean(data.totalDiscountIsAmt),
        showPaidStamp: Boolean(data.showPaidStamp),
        showSignature: Boolean(data.showSignature),
        currency: data.currency || profile.currency || 'Rp',
        notes: data.notes || '',
        items: Array.isArray(data.items) ? data.items.map(item => ({
          name: item.productName || item.name || '',
          qty: Number(item.qty) || 1,
          rate: Number(item.rate) || 0,
          discountPct: Number(item.discountPct) || 0,
          discountIsAmt: Boolean(item.discountIsAmt)
        })) : []
      };
    }),
    inventory: stockSnapshot.docs.map(stockDoc => {
      const item = stockDoc.data();
      return { name: item.itemName || stockDoc.id, stock: Number(item.stock) || 0, price: Number(item.lastPrice) || 0 };
    }),
    expenses: expenseSnapshot.docs.map(expenseDoc => {
      const expense = expenseDoc.data();
      return {
        id: expenseDoc.id,
        description: expense.description || '',
        amount: Number(expense.amount) || 0,
        category: expense.category || 'General',
        date: Number(expense.date) || Date.now(),
        isCogs: Number(expense.isCogs) || 0
      };
    })
  };
  localStorage.setItem(`${STORAGE_KEY}:${userId}`, JSON.stringify(state));
}

function renderAuth(errorMessage = '') {
  const app = document.querySelector('#app');
  const isSignup = authMode === 'signup';
  app.innerHTML = `
    <main class="auth-page">
      <section class="auth-panel" aria-labelledby="auth-title">
        <div class="auth-brand" aria-label="Ledgerix">${renderBrandMark('dark')}<span class="auth-brand-name">edgerix</span></div>
        <p class="eyebrow">Invoice workspace</p>
        <h1 id="auth-title">${isSignup ? 'Create your account' : 'Welcome back'}</h1>
        <p class="auth-copy">${isSignup ? 'Start managing your business invoices securely.' : 'Sign in to access your invoices and business data.'}</p>
        ${errorMessage ? `<p class="auth-error" role="alert">${escapeHtml(errorMessage)}</p>` : ''}
        <button class="button secondary google-button" id="google-signin" type="button"><span class="google-g" aria-hidden="true">G</span> Continue with Google</button>
        <div class="auth-divider"><span>or continue with email</span></div>
        <form id="auth-form" class="auth-form">
          ${isSignup ? '<div class="field"><label for="auth-name">Your name</label><input id="auth-name" name="name" autocomplete="name" required placeholder="Name or business name" /></div>' : ''}
          <div class="field"><label for="auth-email">Email address</label><input id="auth-email" name="email" type="email" autocomplete="email" required placeholder="you@example.com" /></div>
          <div class="field"><label for="auth-password">Password</label><input id="auth-password" name="password" type="password" autocomplete="${isSignup ? 'new-password' : 'current-password'}" minlength="6" required placeholder="At least 6 characters" /></div>
          ${!isSignup ? '<button class="auth-forgot" id="forgot-password" type="button">Forgot password?</button>' : ''}
          <button class="button auth-submit" type="submit">${isSignup ? 'Create account' : 'Sign in'}</button>
        </form>
        <p class="auth-switch">${isSignup ? 'Already have an account?' : 'New to Ledgerix?'} <button id="auth-mode-toggle" type="button">${isSignup ? 'Sign in' : 'Create account'}</button></p>
      </section>
      <aside class="auth-aside"><div class="auth-aside-mark">L</div><p class="eyebrow">Your business, in order</p><h2>Invoices that keep work moving.</h2><p>Sign in with the same Ledgerix account you use on Android to access your synced business data.</p></aside>
    </main>`;
  bindAuthEvents();
}

function bindAuthEvents() {
  document.querySelector('#auth-mode-toggle').addEventListener('click', () => {
    authMode = authMode === 'signin' ? 'signup' : 'signin';
    renderAuth();
  });
  document.querySelector('#auth-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email')).trim();
    const password = String(form.get('password'));
    const submit = event.currentTarget.querySelector('[type="submit"]');
    submit.disabled = true;
    submit.textContent = authMode === 'signup' ? 'Creating account…' : 'Signing in…';
    try {
      if (authMode === 'signup') {
        const result = await createUserWithEmailAndPassword(auth, email, password);
        const name = String(form.get('name') || '').trim();
        if (name) await updateProfile(result.user, { displayName: name });
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (error) {
      renderAuth(authErrorMessage(error));
    }
  });
  document.querySelector('#google-signin').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      await signInWithPopup(auth, provider);
    } catch (error) {
      renderAuth(authErrorMessage(error));
    }
  });
  document.querySelector('#forgot-password')?.addEventListener('click', async () => {
    const email = document.querySelector('#auth-email').value.trim();
    if (!email) return renderAuth('Enter your email address first, then choose Forgot password.');
    try {
      await sendPasswordResetEmail(auth, email);
      renderAuth('Password reset email sent. Check your inbox.');
    } catch (error) {
      renderAuth(authErrorMessage(error));
    }
  });
}

function authErrorMessage(error) {
  const messages = {
    'auth/invalid-credential': 'Email or password is incorrect.',
    'auth/email-already-in-use': 'An account already uses this email. Try signing in instead.',
    'auth/weak-password': 'Choose a password with at least 6 characters.',
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/popup-closed-by-user': 'Google sign-in was cancelled.',
    'auth/unauthorized-domain': 'This website domain is not authorized in Firebase Authentication settings.'
  };
  return messages[error.code] || error.message || 'Sign-in failed. Please try again.';
}

async function startAppForUser(user) {
  currentUser = user;
  currentPage = 'overview';
  state = loadState(user.uid);
  document.querySelector('#app').innerHTML = '<main class="auth-loading">Loading your Ledgerix account…</main>';
  try {
    await loadCloudState(user.uid);
  } catch (error) {
    console.error('Ledgerix cloud data load failed:', error);
    render();
    showToast('Could not load cloud data. Check your Firestore rules and connection.');
    return;
  }
  render();
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function renderBrandMark(variant = 'light') {
  const asset = variant === 'dark' ? 'ledgerix-mark-dark.png' : 'ledgerix-mark.png';
  return `<span class="brand-mark" aria-hidden="true"><img src="./${asset}" alt="" /></span>`;
}

function formatAmount(value, currency = state.profile.currency) {
  const locale = currency === 'Rp' ? 'id-ID' : 'en-US';
  const amount = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Number(value) || 0);
  return currency === 'Rp' ? `Rp ${amount}.-` : `${currency} ${amount}`;
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('en-GB').format(date);
}

function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function lineDiscountAmount(item) {
  const base = Math.max(0, Number(item.qty) || 0) * Math.max(0, Number(item.rate) || 0);
  const discount = Math.max(0, Number(item.discountPct) || 0);
  return Math.min(base, item.discountIsAmt ? discount : base * Math.min(discount, 100) / 100);
}

function invoiceItemsSubtotal(invoice) {
  return (invoice.items || []).reduce((sum, item) => sum + Math.max(0, (Number(item.qty) || 0) * (Number(item.rate) || 0) - lineDiscountAmount(item)), 0);
}

function invoiceTotalDiscount(invoice) {
  const subtotal = invoiceItemsSubtotal(invoice);
  const value = Math.max(0, Number(invoice.totalDiscountPct) || 0);
  const discount = invoice.totalDiscountIsAmt ? value : subtotal * Math.min(value, 100) / 100;
  return Math.min(subtotal, discount);
}

function invoiceTotal(invoice) {
  if (!invoice.items?.length) return Number(invoice.totalAmount) || 0;
  return Math.max(0, invoiceItemsSubtotal(invoice) - invoiceTotalDiscount(invoice));
}

function invoiceStatus(invoice) {
  const total = invoiceTotal(invoice);
  if (invoice.amountPaid >= total && total > 0) return ['Paid', 'paid'];
  if (invoice.amountPaid > 0) return ['Partial', 'partial'];
  return ['Unpaid', 'unpaid'];
}

function pageTitle() {
  return ({ overview: 'Overview', invoices: 'Invoices', inventory: 'Inventory', analytics: 'Analytics', settings: 'Profile & Settings', editor: activeInvoiceId ? 'Edit Invoice' : 'New Invoice', detail: 'Invoice Preview' })[currentPage] || 'Ledgerix';
}

function renderShell() {
  const app = document.querySelector('#app');
  const navItems = [
    ['overview', 'Overview'], ['invoices', 'Invoices'], ['inventory', 'Inventory'], ['analytics', 'Analytics'], ['settings', 'Settings']
  ];
  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <a class="brand" href="#" data-page="overview" aria-label="Ledgerix">
          ${renderBrandMark()}
          <span class="brand-name">edgerix<span>INVOICE WORKSPACE</span></span>
        </a>
        <div class="nav-label">Workspace</div>
        <nav class="nav-list" aria-label="Main navigation">
          ${navItems.map(([page, label]) => `<button class="nav-button ${currentPage === page ? 'active' : ''}" data-page="${page}" type="button"><span class="nav-icon material-icon" aria-hidden="true">${icons[page]}</span><span>${label}</span></button>`).join('')}
        </nav>
        <div class="sidebar-bottom">Synced to your Ledgerix account.<br />Ledgerix · Invoice maker</div>
      </aside>
      <main class="main">
        <header class="topbar">
          <div><div class="mobile-brand" aria-label="Ledgerix">${renderBrandMark('dark')}<span>edgerix</span></div><h1 class="page-heading">${escapeHtml(pageTitle())}</h1><p class="page-subtitle">Create, track, and share your business invoices.</p></div>
          <div class="top-actions">
            ${currentPage !== 'editor' && currentPage !== 'detail' ? '<button class="button" data-action="new-invoice" type="button"><span aria-hidden="true">＋</span> New invoice</button>' : ''}
            <div class="user-chip"><span class="avatar">${escapeHtml((state.profile.name || currentUser.email || 'L').trim().charAt(0).toUpperCase())}</span><span>${escapeHtml(state.profile.name || currentUser.email || 'Your account')}</span></div>
            <button class="icon-button account-switch" data-action="switch-account" type="button" title="Switch account" aria-label="Switch account">⇄</button>
          </div>
        </header>
        <div class="content" id="page-content"></div>
      </main>
    </div>`;
  renderPage();
}

function render() {
  if (!currentUser) {
    renderAuth();
    return;
  }
  renderShell();
}

function renderPage() {
  const container = document.querySelector('#page-content');
  const pages = { overview: renderOverview, invoices: renderInvoices, inventory: renderInventory, analytics: renderAnalytics, settings: renderSettings, editor: renderEditor, detail: renderInvoiceDetail };
  container.innerHTML = (pages[currentPage] || renderOverview)();
  bindPageEvents();
}

function renderOverview() {
  const total = state.invoices.reduce((sum, invoice) => sum + invoiceTotal(invoice), 0);
  const collected = state.invoices.reduce((sum, invoice) => sum + Number(invoice.amountPaid || 0), 0);
  const pending = Math.max(0, total - collected);
  const recent = [...state.invoices].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
  const monthName = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric' }).format(new Date());
  const collectionRate = total > 0 ? Math.min(100, Math.round((collected / total) * 100)) : 0;
  const outstandingCount = state.invoices.filter(invoice => invoiceTotal(invoice) > Number(invoice.amountPaid || 0)).length;
  const monthlySales = Array.from({ length: 6 }, (_, index) => {
    const month = new Date();
    month.setDate(1);
    month.setMonth(month.getMonth() - (5 - index));
    const key = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`;
    return {
      label: new Intl.DateTimeFormat('en', { month: 'short' }).format(month),
      amount: state.invoices.filter(invoice => invoice.date.startsWith(key)).reduce((sum, invoice) => sum + invoiceTotal(invoice), 0)
    };
  });
  const salesPeak = Math.max(...monthlySales.map(month => month.amount), 1);
  return `
    <div class="dashboard-intro"><div><p class="eyebrow">${escapeHtml(monthName)}</p><h2>${escapeHtml(state.profile.name || 'Welcome to Ledgerix')}</h2><p class="dashboard-description">Your business, at a glance.</p></div><div class="dashboard-intro-actions">${state.profile.name.trim() ? '' : '<button class="button secondary" data-page="settings" type="button">Set up profile</button>'}</div></div>
    <section class="metric-grid" aria-label="Invoice totals">
      <article class="metric metric-sales"><div class="metric-head"><span class="metric-label">Total sales</span><span class="metric-symbol" aria-hidden="true">↗</span></div><div class="metric-value">${formatAmount(total)}</div><div class="metric-note">${state.invoices.length} invoice${state.invoices.length === 1 ? '' : 's'} created</div></article>
      <article class="metric metric-collected"><div class="metric-head"><span class="metric-label">Collected</span><span class="metric-symbol" aria-hidden="true">✓</span></div><div class="metric-value">${formatAmount(collected)}</div><div class="metric-note">Payments received</div></article>
      <article class="metric metric-pending"><div class="metric-head"><span class="metric-label">Pending</span><span class="metric-symbol" aria-hidden="true">◷</span></div><div class="metric-value">${formatAmount(pending)}</div><div class="metric-note">${outstandingCount} invoice${outstandingCount === 1 ? '' : 's'} awaiting payment</div></article>
    </section>
    <div class="overview-layout">
      <section class="panel sales-panel"><div class="panel-inner"><div class="panel-heading"><div><p class="eyebrow">Six-month overview</p><h3>Sales activity</h3></div><div class="chart-total"><span>Invoiced</span><strong>${formatAmount(total)}</strong></div></div><div class="sales-chart" role="img" aria-label="Sales activity over the last six months">${monthlySales.map(month => `<div class="chart-column" title="${escapeHtml(month.label)}: ${formatAmount(month.amount)}"><div class="chart-bar-track"><div class="chart-bar-fill" style="height:${Math.max(4, (month.amount / salesPeak) * 100)}%"></div></div><span class="chart-label">${escapeHtml(month.label)}</span></div>`).join('')}</div></div></section>
      <div class="overview-side">
        <section class="panel collection-panel"><div class="panel-inner"><div class="panel-heading"><div><p class="eyebrow">Payments</p><h3>Collection progress</h3></div><span class="collection-rate">${collectionRate}%</span></div><strong class="collection-amount">${formatAmount(pending)}</strong><p class="collection-caption">Still outstanding</p><div class="collection-track" role="progressbar" aria-label="Payments collected" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${collectionRate}"><span style="width:${collectionRate}%"></span></div><div class="collection-footer"><span>${formatAmount(collected)} collected</span><span>${outstandingCount} open</span></div></div></section>
        <section class="panel quick-panel"><div class="panel-inner"><div class="panel-heading"><h3>Quick actions</h3></div><div class="quick-actions"><button class="quick-action" data-action="new-invoice" type="button"><span class="quick-action-icon new-invoice-icon" aria-hidden="true">＋</span><span><strong>New invoice</strong><small>Create and send a bill</small></span><span class="quick-arrow" aria-hidden="true">›</span></button><button class="quick-action" data-action="open-expenses" type="button"><span class="quick-action-icon expense-icon" aria-hidden="true">−</span><span><strong>Add expense</strong><small>Record a business cost</small></span><span class="quick-arrow" aria-hidden="true">›</span></button><button class="quick-action" data-page="inventory" type="button"><span class="quick-action-icon stock-icon" aria-hidden="true">▦</span><span><strong>Manage stock</strong><small>${state.inventory.length} saved item${state.inventory.length === 1 ? '' : 's'}</small></span><span class="quick-arrow" aria-hidden="true">›</span></button></div></div></section>
      </div>
    </div>
    <section class="panel recent-panel"><div class="panel-inner"><div class="panel-heading"><div><p class="eyebrow">Latest activity</p><h3>Recent invoices</h3></div><button class="text-link" data-page="invoices" type="button">View all invoices <span aria-hidden="true">→</span></button></div>${recent.length ? `<div class="table-wrap"><table class="invoice-table"><thead><tr><th>Invoice</th><th>Customer</th><th>Date</th><th>Status</th><th>Total</th><th></th></tr></thead><tbody>${recent.map(invoiceRow).join('')}</tbody></table></div>` : `<div class="empty-state"><strong>Your invoice list starts here</strong><p>Create your first invoice to keep sales, payments, and customer details together.</p><button class="button" data-action="new-invoice" type="button">＋ Create an invoice</button></div>`}</div></section>`;
}

function invoiceRow(invoice) {
  const [status, className] = invoiceStatus(invoice);
  return `<tr class="clickable-row" role="button" tabindex="0" data-action="open-invoice" data-id="${escapeHtml(invoice.id)}" aria-label="Open invoice ${escapeHtml(invoice.invoiceNo)}"><td data-label="Invoice"><strong>${escapeHtml(invoice.invoiceNo)}</strong></td><td data-label="Customer">${escapeHtml(invoice.customerName)}</td><td data-label="Date">${formatDate(invoice.date)}</td><td data-label="Status"><span class="status ${className}">${status}</span></td><td data-label="Total"><strong>${formatAmount(invoiceTotal(invoice), invoice.currency)}</strong></td><td data-label="Open"><span class="row-open-indicator" aria-hidden="true">›</span></td></tr>`;
}

function renderInvoices() {
  const invoices = [...state.invoices].filter(invoice => `${invoice.invoiceNo} ${invoice.customerName}`.toLowerCase().includes(searchTerm.toLowerCase())).sort((a, b) => b.date.localeCompare(a.date));
  return `<div class="toolbar"><div><p class="eyebrow">${state.invoices.length} total</p><h2 class="page-heading">All invoices</h2></div><input class="search-field" id="invoice-search" type="search" placeholder="Search customer or invoice…" value="${escapeHtml(searchTerm)}" aria-label="Search invoices" /></div>
    <section class="panel"><div class="table-wrap">${invoices.length ? `<table class="invoice-table"><thead><tr><th>Invoice</th><th>Customer</th><th>Date</th><th>Status</th><th>Total</th><th>Received</th><th></th></tr></thead><tbody>${invoices.map(invoice => invoiceRowWithPaid(invoice)).join('')}</tbody></table>` : `<div class="empty-state"><strong>${searchTerm ? 'No matching invoices' : 'No invoices yet'}</strong><p>${searchTerm ? 'Try another customer name or invoice number.' : 'Create an invoice and it will appear here.'}</p>${!searchTerm ? '<button class="button" data-action="new-invoice" type="button">＋ New invoice</button>' : ''}</div>`}</div></section>`;
}

function invoiceRowWithPaid(invoice) {
  const [status, className] = invoiceStatus(invoice);
  return `<tr class="clickable-row" role="button" tabindex="0" data-action="open-invoice" data-id="${escapeHtml(invoice.id)}" aria-label="Open invoice ${escapeHtml(invoice.invoiceNo)}"><td data-label="Invoice"><strong>${escapeHtml(invoice.invoiceNo)}</strong></td><td data-label="Customer">${escapeHtml(invoice.customerName)}</td><td data-label="Date">${formatDate(invoice.date)}</td><td data-label="Status"><span class="status ${className}">${status}</span></td><td data-label="Total"><strong>${formatAmount(invoiceTotal(invoice), invoice.currency)}</strong></td><td data-label="Received">${formatAmount(invoice.amountPaid || 0, invoice.currency)}</td><td data-label="Open"><span class="row-open-indicator" aria-hidden="true">›</span></td></tr>`;
}

function renderEditor() {
  const invoice = state.invoices.find(item => item.id === activeInvoiceId);
  const draft = invoice || { customerName: '', date: todayIso(), currency: state.profile.currency, amountPaid: 0, totalDiscountPct: 0, totalDiscountIsAmt: false, showPaidStamp: false, showSignature: false, notes: '', items: [{ name: '', qty: 1, rate: 0, discountPct: 0, discountIsAmt: false }] };
  const discountEnabled = Boolean(state.profile.discountEnabled);
  const showItemDiscounts = discountEnabled || draft.items.some(item => Number(item.discountPct) > 0);
  const showTotalDiscount = discountEnabled || Number(draft.totalDiscountPct) > 0;
  const hasSignature = Boolean(state.profile.signatureUrl);
  const invoiceNumber = invoice?.invoiceNo || `${state.profile.invoicePrefix}-${String(state.profile.invoiceCounter).padStart(4, '0')}`;
  return `<div class="toolbar"><div><p class="eyebrow">${invoice ? escapeHtml(invoice.invoiceNo) : 'Invoice details'}</p><h2 class="page-heading">${invoice ? 'Update invoice' : 'Create an invoice'}</h2></div><button class="button secondary" data-action="back" type="button">← Back</button></div>
    <form id="invoice-form" class="invoice-editor">
      <div class="form-stack">
        <section class="panel form-section"><h3>Customer information</h3><div class="form-grid">
          <div class="field"><label for="customer-name">Customer name</label><input id="customer-name" name="customerName" required autocomplete="organization" value="${escapeHtml(draft.customerName)}" placeholder="Customer or company" /></div>
          <div class="field"><label for="invoice-date">Invoice date</label><input id="invoice-date" name="date" type="date" required value="${escapeHtml(draft.date)}" /></div>
          <div class="field"><label for="invoice-number">Invoice number</label><input id="invoice-number" value="${escapeHtml(invoiceNumber)}" readonly /></div>
          <div class="field"><label for="invoice-currency">Currency</label><select id="invoice-currency" name="currency">${currencies.map(currency => `<option ${draft.currency === currency ? 'selected' : ''}>${currency}</option>`).join('')}</select></div>
        </div></section>
        <section class="panel form-section"><h3>Invoice items</h3><div class="line-head"><span>Item</span><span>Qty</span><span>Rate</span><span>${showItemDiscounts ? 'Discount' : ''}</span><span class="line-total">Amount</span><span></span></div><div id="invoice-items">${draft.items.map(item => lineItemHtml(item, showItemDiscounts, !discountEnabled)).join('')}</div><button class="button secondary small add-line" data-action="add-line" type="button">＋ Add item</button></section>
        <section class="panel form-section"><h3>Payment & notes</h3>
          <div class="form-grid">
            <div class="field"><label for="amount-paid">Amount received</label><input id="amount-paid" name="amountPaid" type="number" min="0" step="1" value="${Number(draft.amountPaid || 0)}" /></div>
            ${showTotalDiscount ? `<div class="field"><label for="total-discount">Invoice discount</label><div class="discount-control"><input id="total-discount" name="totalDiscountPct" type="number" min="0" step="any" value="${Number(draft.totalDiscountPct || 0) || ''}" placeholder="0" ${discountEnabled ? '' : 'disabled'} /><button class="discount-toggle" data-action="toggle-total-discount" data-amount="${Boolean(draft.totalDiscountIsAmt)}" type="button" ${discountEnabled ? '' : 'disabled'}>${draft.totalDiscountIsAmt ? escapeHtml(draft.currency) : '%'}</button></div></div>` : ''}
            <div class="field full"><label for="invoice-notes">Notes</label><textarea id="invoice-notes" name="notes" placeholder="Payment terms or a note for your customer">${escapeHtml(draft.notes)}</textarea></div>
            <div class="field full invoice-options">
              <label class="check-option"><input id="show-paid-stamp" name="showPaidStamp" type="checkbox" ${draft.showPaidStamp ? 'checked' : ''} /><span>Show PAID stamp on invoice</span></label>
              ${hasSignature ? `<label class="check-option"><input id="show-signature" name="showSignature" type="checkbox" ${draft.showSignature ? 'checked' : ''} /><span>Include business signature</span></label>` : ''}
            </div>
          </div>
        </section>
      </div>
      <aside class="panel summary-box"><h3>Invoice summary</h3><div class="summary-row"><span>Subtotal</span><strong id="summary-subtotal">—</strong></div><div class="summary-row discount-summary" id="summary-discount-row" hidden><span>Discount</span><strong id="summary-discount">—</strong></div><div class="summary-row total"><span>Total</span><strong id="summary-total">—</strong></div><div class="summary-row"><span>Received</span><strong id="summary-paid">—</strong></div><div class="summary-row balance"><span>Balance due</span><strong id="summary-balance">—</strong></div><div class="summary-actions"><button class="button" type="submit">Save invoice</button><button class="button secondary" data-action="back" type="button">Cancel</button></div></aside>
    </form>`;
}

function lineItemHtml(item = {}, discountEnabled = true, discountReadOnly = false) {
  const discount = `<div class="discount-control"><input data-field="discount" type="number" min="0" step="any" aria-label="Item discount" value="${Number(item.discountPct) || ''}" placeholder="0" ${discountReadOnly ? 'disabled' : ''} /><button class="discount-toggle" data-action="toggle-line-discount" data-amount="${Boolean(item.discountIsAmt)}" type="button" ${discountReadOnly ? 'disabled' : ''}>${item.discountIsAmt ? escapeHtml(state.profile.currency) : '%'}</button></div>`;
  return `<div class="invoice-line" data-discount-amt="${Boolean(item.discountIsAmt)}"><input data-field="name" required aria-label="Item description" placeholder="Product or service" value="${escapeHtml(item.name || '')}" /><input data-field="qty" type="number" min="1" step="1" required aria-label="Quantity" value="${Number(item.qty) || 1}" /><input data-field="rate" type="number" min="0" step="1" required aria-label="Rate" value="${Number(item.rate) || ''}" placeholder="0" />${discountEnabled ? discount : `<input type="hidden" data-field="discount" value="${Number(item.discountPct) || 0}" />`}<div class="line-total">${formatAmount(Math.max(0, (Number(item.qty) || 0) * (Number(item.rate) || 0) - lineDiscountAmount(item)))}</div><button class="icon-button" data-action="remove-line" type="button" aria-label="Remove item">×</button></div>`;
}

function renderInvoiceDetail() {
  const invoice = state.invoices.find(item => item.id === activeInvoiceId);
  if (!invoice) { currentPage = 'invoices'; return renderInvoices(); }
  const [status, statusClass] = invoiceStatus(invoice);
  const profile = state.profile;
  const isPaid = invoiceTotal(invoice) > 0 && Number(invoice.amountPaid) >= invoiceTotal(invoice);
  return `<div class="toolbar no-print"><div><p class="eyebrow">${escapeHtml(invoice.invoiceNo)} · <span class="status ${statusClass}">${status}</span></p><h2 class="page-heading">Invoice for ${escapeHtml(invoice.customerName)}</h2></div><div class="top-actions"><button class="button ${isPaid ? 'secondary' : 'green'}" data-action="toggle-invoice-status" data-id="${escapeHtml(invoice.id)}" type="button">Mark as ${isPaid ? 'unpaid' : 'paid'}</button><button class="button secondary" data-action="edit-invoice" type="button">Edit</button><button class="button secondary" data-action="share-invoice" type="button">Share</button><button class="button" data-action="print-invoice" type="button">Print / PDF</button></div></div>
    <article class="invoice-paper" id="invoice-paper"><div class="paper-top"><div class="paper-brand">${escapeHtml(profile.name || 'Ledgerix')}<small>${escapeHtml(profile.address)}${profile.taxId ? `<br />Tax ID: ${escapeHtml(profile.taxId)}` : ''}</small></div><div><div class="paper-title">INVOICE</div><div class="paper-meta"><strong>${escapeHtml(invoice.invoiceNo)}</strong><br />Date: ${formatDate(invoice.date)}</div></div></div>
    <div class="paper-parties"><div><h4>Bill to</h4><p><strong>${escapeHtml(invoice.customerName)}</strong></p></div><div><h4>Payment details</h4><p>${escapeHtml(profile.bankDetails || profile.paypalEmail || 'Payment details not added')}</p></div></div>
    <div class="table-wrap"><table class="paper-table"><thead><tr><th>Description</th><th class="right">Qty</th><th class="right">Rate</th><th class="right">Amount</th></tr></thead><tbody>${invoice.items.map(item => `<tr><td>${escapeHtml(item.name)}</td><td class="right">${item.qty}</td><td class="right">${formatAmount(item.rate, invoice.currency)}</td><td class="right">${formatAmount(item.qty * item.rate, invoice.currency)}</td></tr>`).join('')}</tbody></table></div>
    <div class="paper-totals"><div class="summary-row"><span>Subtotal</span><strong>${formatAmount(invoiceTotal(invoice), invoice.currency)}</strong></div><div class="summary-row total"><span>Total</span><strong>${formatAmount(invoiceTotal(invoice), invoice.currency)}</strong></div><div class="summary-row"><span>Amount received</span><strong>${formatAmount(invoice.amountPaid || 0, invoice.currency)}</strong></div><div class="summary-row balance"><span>Balance due</span><strong>${formatAmount(Math.max(0, invoiceTotal(invoice) - invoice.amountPaid), invoice.currency)}</strong></div></div>
    ${invoice.notes ? `<div class="paper-note"><strong>Notes</strong><br />${escapeHtml(invoice.notes)}</div>` : ''}</article>`;
}

function renderInventory() {
  const products = [...state.inventory].sort((a, b) => a.name.localeCompare(b.name));
  const expenses = [...state.expenses].sort((a, b) => Number(b.date) - Number(a.date));
  return `<div class="toolbar"><div><p class="eyebrow">Business operations</p><h2 class="page-heading">Inventory & expenses</h2></div></div>
    <div class="segmented-tabs" role="tablist" aria-label="Inventory sections">
      <button class="segmented-tab ${inventoryTab === 'stock' ? 'active' : ''}" data-inventory-tab="stock" role="tab" aria-selected="${inventoryTab === 'stock'}" type="button">Stock</button>
      <button class="segmented-tab ${inventoryTab === 'expenses' ? 'active' : ''}" data-inventory-tab="expenses" role="tab" aria-selected="${inventoryTab === 'expenses'}" type="button">Expenses</button>
    </div>
    ${inventoryTab === 'stock' ? `<section class="panel"><div class="panel-inner"><div class="panel-heading"><h3>Saved items</h3><span class="page-subtitle">Stock is reduced when an invoice is saved.</span></div><form id="stock-form" class="stock-form"><input name="name" required placeholder="Item name" aria-label="Item name" /><input name="stock" type="number" min="0" step="1" value="0" aria-label="Quantity in stock" /><input name="price" type="number" min="0" step="1" placeholder="Last price" aria-label="Last price" /><button class="button small" type="submit">Add item</button></form>${products.length ? `<div class="table-wrap"><table><thead><tr><th>Product</th><th>On hand</th><th>Last price</th><th></th></tr></thead><tbody>${products.map((item, index) => `<tr><td><strong>${escapeHtml(item.name)}</strong></td><td>${Number(item.stock) || 0}</td><td>${formatAmount(item.price || 0)}</td><td><button class="icon-button" data-action="delete-stock" data-index="${index}" aria-label="Remove ${escapeHtml(item.name)}" type="button">×</button></td></tr>`).join('')}</tbody></table></div>` : `<div class="empty-state"><strong>No saved products</strong><p>Add your commonly used products here to track stock as you invoice.</p></div>`}</div></section>` : `<div class="form-stack"><section class="panel form-section"><h3>Add expense</h3><form id="expense-form" class="form-grid"><div class="field full"><label for="expense-description">Description</label><input id="expense-description" name="description" required placeholder="What was the expense?" /></div><div class="field"><label for="expense-amount">Amount</label><input id="expense-amount" name="amount" type="number" min="1" step="1" required placeholder="0" /></div><div class="field"><label for="expense-category">Category</label><select id="expense-category" name="category"><option>General</option><option>COGS</option><option>Travel</option><option>Supplies</option><option>Utilities</option></select></div><div class="field"><label for="expense-date">Date</label><input id="expense-date" name="date" type="date" required value="${todayIso()}" /></div><div class="field full"><button class="button" type="submit">Add expense</button></div></form></section><section class="panel"><div class="panel-inner"><div class="panel-heading"><h3>Recent expenses</h3><span class="page-subtitle">${expenses.length} recorded</span></div>${expenses.length ? `<div class="table-wrap"><table><thead><tr><th>Description</th><th>Category</th><th>Date</th><th>Amount</th><th></th></tr></thead><tbody>${expenses.map(expense => `<tr><td><strong>${escapeHtml(expense.description)}</strong></td><td>${escapeHtml(expense.category || 'General')}</td><td>${new Intl.DateTimeFormat('en-GB').format(new Date(Number(expense.date) || Date.now()))}</td><td><strong>${formatAmount(expense.amount)}</strong></td><td><button class="icon-button" data-action="delete-expense" data-id="${escapeHtml(expense.id)}" aria-label="Delete expense ${escapeHtml(expense.description)}" type="button">×</button></td></tr>`).join('')}</tbody></table></div>` : `<div class="empty-state"><strong>No expenses yet</strong><p>Add an expense and it will sync to your Ledgerix Firebase account.</p></div>`}</div></section></div>`}`;
}

function renderAnalytics() {
  const topCustomers = Object.values(state.invoices.reduce((groups, invoice) => {
    const key = invoice.customerName || 'Unknown';
    groups[key] ||= { name: key, total: 0, count: 0 };
    groups[key].total += invoiceTotal(invoice);
    groups[key].count += 1;
    return groups;
  }, {})).sort((a, b) => b.total - a.total).slice(0, 6);
  const monthTotals = Array.from({ length: 6 }, (_, offset) => {
    const date = new Date(); date.setDate(1); date.setMonth(date.getMonth() - (5 - offset));
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    return { label: new Intl.DateTimeFormat('en', { month: 'short' }).format(date), total: state.invoices.filter(invoice => invoice.date.startsWith(key)).reduce((sum, invoice) => sum + invoiceTotal(invoice), 0) };
  });
  const max = Math.max(...monthTotals.map(item => item.total), 1);
  return `<div class="toolbar"><div><p class="eyebrow">Business performance</p><h2 class="page-heading">Analytics</h2></div></div><div class="dashboard-grid"><section class="panel"><div class="panel-inner"><div class="panel-heading"><h3>Sales · last 6 months</h3></div><div class="stat-bars">${monthTotals.map(item => `<div class="stat-bar-wrap" title="${formatAmount(item.total)}"><div class="stat-bar" style="height:${Math.max(3, (item.total / max) * 100)}%"></div><span class="stat-month">${item.label}</span></div>`).join('')}</div></div></section><section class="panel"><div class="panel-inner"><div class="panel-heading"><h3>Top customers</h3></div>${topCustomers.length ? `<div class="activity-list">${topCustomers.map(customer => `<div class="activity-row"><span><span class="activity-name">${escapeHtml(customer.name)}</span><span class="activity-meta">${customer.count} invoice${customer.count === 1 ? '' : 's'}</span></span><strong>${formatAmount(customer.total)}</strong></div>`).join('')}</div>` : `<div class="empty-state"><strong>No sales data yet</strong><p>Customer totals will appear after you save invoices.</p></div>`}</div></section></div>`;
}

function renderSettings() {
  const profile = state.profile;
  return `<div class="toolbar"><div><p class="eyebrow">Business details</p><h2 class="page-heading">Profile & settings</h2></div></div><div class="settings-grid"><form id="settings-form" class="panel form-section"><h3>Business branding</h3><div class="form-grid"><div class="field full"><label for="business-name">Business name</label><input id="business-name" name="name" value="${escapeHtml(profile.name)}" placeholder="Your business name" /></div><div class="field full"><label for="business-address">Address</label><textarea id="business-address" name="address" placeholder="Business address">${escapeHtml(profile.address)}</textarea></div><div class="field"><label for="tax-id">Tax ID</label><input id="tax-id" name="taxId" value="${escapeHtml(profile.taxId)}" placeholder="Tax registration number" /></div><div class="field"><label for="invoice-prefix">Invoice prefix</label><input id="invoice-prefix" name="invoicePrefix" value="${escapeHtml(profile.invoicePrefix)}" maxlength="12" /></div><div class="field"><label for="default-currency">Default currency</label><select id="default-currency" name="currency">${currencies.map(currency => `<option ${profile.currency === currency ? 'selected' : ''}>${currency}</option>`).join('')}</select></div><div class="field"><label for="paypal-email">PayPal email</label><input id="paypal-email" name="paypalEmail" type="email" value="${escapeHtml(profile.paypalEmail)}" placeholder="payments@example.com" /></div><div class="field full"><label for="bank-details">Bank account details</label><textarea id="bank-details" name="bankDetails" placeholder="Bank name and account details">${escapeHtml(profile.bankDetails)}</textarea></div></div><div style="margin-top:16px"><button class="button" type="submit">Save changes</button></div></form><aside class="panel"><div class="panel-inner"><div class="panel-heading"><h3>Automatic cloud sync</h3></div><p class="page-subtitle" style="line-height:1.7">Changes to your profile, invoices, stock, and expenses are automatically saved to your signed-in Firebase account.</p><button class="button danger small" data-action="clear-data" type="button">Clear this browser’s cached copy</button></div></aside></div>`;
}

function startNewInvoice() {
  activeInvoiceId = null;
  currentPage = 'editor';
  render();
}

function updateEditorTotals() {
  const lines = [...document.querySelectorAll('.invoice-line')];
  const currency = document.querySelector('#invoice-currency')?.value || state.profile.currency;
  const items = lines.map(line => ({
    qty: Number(line.querySelector('[data-field="qty"]').value) || 0,
    rate: Number(line.querySelector('[data-field="rate"]').value) || 0,
    discountPct: Number(line.querySelector('[data-field="discount"]')?.value) || 0,
    discountIsAmt: line.dataset.discountAmt === 'true'
  }));
  const subtotal = items.reduce((sum, item) => sum + Math.max(0, item.qty * item.rate - lineDiscountAmount(item)), 0);
  const totalDiscountValue = Number(document.querySelector('#total-discount')?.value) || 0;
  const totalDiscountIsAmt = document.querySelector('[data-action="toggle-total-discount"]')?.dataset.amount === 'true';
  const totalDiscount = Math.min(subtotal, totalDiscountIsAmt ? totalDiscountValue : subtotal * Math.min(totalDiscountValue, 100) / 100);
  const total = Math.max(0, subtotal - totalDiscount);
  const paid = Number(document.querySelector('#amount-paid')?.value) || 0;
  lines.forEach((line, index) => {
    line.querySelector('.line-total').textContent = formatAmount(Math.max(0, items[index].qty * items[index].rate - lineDiscountAmount(items[index])), currency);
  });
  document.querySelector('#summary-subtotal').textContent = formatAmount(subtotal, currency);
  document.querySelector('#summary-discount').textContent = `-${formatAmount(totalDiscount, currency)}`;
  document.querySelector('#summary-discount-row').hidden = totalDiscount <= 0;
  document.querySelector('#summary-total').textContent = formatAmount(total, currency);
  document.querySelector('#summary-paid').textContent = formatAmount(paid, currency);
  document.querySelector('#summary-balance').textContent = formatAmount(Math.max(0, total - paid), currency);
}

function readInvoiceForm(form) {
  const data = new FormData(form);
  const existingInvoice = state.invoices.find(item => item.id === activeInvoiceId);
  const items = [...document.querySelectorAll('.invoice-line')].map(line => ({
    name: line.querySelector('[data-field="name"]').value.trim(),
    qty: Math.max(1, Number(line.querySelector('[data-field="qty"]').value) || 1),
    rate: Math.max(0, Number(line.querySelector('[data-field="rate"]').value) || 0),
    discountPct: Math.max(0, Number(line.querySelector('[data-field="discount"]')?.value) || 0),
    discountIsAmt: line.dataset.discountAmt === 'true'
  }));
  const totalDiscount = document.querySelector('#total-discount');
  return {
    customerName: String(data.get('customerName')).trim(),
    date: String(data.get('date')),
    currency: String(data.get('currency')),
    amountPaid: Math.max(0, Number(data.get('amountPaid')) || 0),
    totalDiscountPct: totalDiscount ? Math.max(0, Number(totalDiscount.value) || 0) : Number(existingInvoice?.totalDiscountPct) || 0,
    totalDiscountIsAmt: document.querySelector('[data-action="toggle-total-discount"]') ? document.querySelector('[data-action="toggle-total-discount"]').dataset.amount === 'true' : Boolean(existingInvoice?.totalDiscountIsAmt),
    showPaidStamp: document.querySelector('#show-paid-stamp') ? document.querySelector('#show-paid-stamp').checked : Boolean(existingInvoice?.showPaidStamp),
    showSignature: document.querySelector('#show-signature') ? document.querySelector('#show-signature').checked : Boolean(existingInvoice?.showSignature),
    notes: String(data.get('notes') || '').trim(),
    items
  };
}

function updateInventoryForInvoice(previous, next) {
  const stock = new Map(state.inventory.map(item => [item.name.toLowerCase(), { ...item }]));
  previous?.items.forEach(item => {
    const key = item.name.toLowerCase();
    if (stock.has(key)) stock.get(key).stock += Number(item.qty) || 0;
  });
  next.items.forEach(item => {
    const key = item.name.toLowerCase();
    if (!stock.has(key)) stock.set(key, { name: item.name, stock: 0, price: item.rate });
    const product = stock.get(key);
    product.stock = Math.max(0, Number(product.stock) - item.qty);
    product.price = item.rate;
  });
  state.inventory = [...stock.values()];
}

function saveInvoiceFromForm(form) {
  const invoiceData = readInvoiceForm(form);
  const previous = state.invoices.find(item => item.id === activeInvoiceId);
  updateInventoryForInvoice(previous, invoiceData);
  if (previous) {
    Object.assign(previous, invoiceData);
  } else {
    invoiceData.id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
    invoiceData.invoiceNo = `${state.profile.invoicePrefix}-${String(state.profile.invoiceCounter).padStart(4, '0')}`;
    state.profile.invoiceCounter += 1;
    state.invoices.push(invoiceData);
    activeInvoiceId = invoiceData.id;
  }
  saveState();
  currentPage = 'detail';
  render();
  showToast('Invoice saved in this browser.');
}

function openInvoice(id) {
  activeInvoiceId = id;
  currentPage = 'detail';
  render();
}

async function shareInvoice() {
  const invoice = state.invoices.find(item => item.id === activeInvoiceId);
  if (!invoice) return;
  const text = `${state.profile.name || 'Invoice'}\n${invoice.invoiceNo} · ${invoice.customerName}\nTotal: ${formatAmount(invoiceTotal(invoice), invoice.currency)}\nBalance due: ${formatAmount(Math.max(0, invoiceTotal(invoice) - invoice.amountPaid), invoice.currency)}`;
  try {
    if (navigator.share) await navigator.share({ title: invoice.invoiceNo, text });
    else { await navigator.clipboard.writeText(text); showToast('Invoice summary copied. Use Print / PDF for a shareable document.'); }
  } catch (error) {
    if (error.name !== 'AbortError') showToast('Could not share from this browser.');
  }
}

function showToast(message) {
  document.querySelector('.toast')?.remove();
  const toast = document.createElement('div');
  toast.className = 'toast'; toast.setAttribute('role', 'status'); toast.textContent = message;
  document.body.append(toast);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.remove(), 3200);
}

function bindPageEvents() {
  document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => {
    currentPage = button.dataset.page; activeInvoiceId = null; render();
  }));
  document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => handleAction(button)));
  document.querySelectorAll('tr.clickable-row').forEach(row => row.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleAction(row);
    }
  }));
  document.querySelectorAll('[data-inventory-tab]').forEach(button => button.addEventListener('click', () => {
    inventoryTab = button.dataset.inventoryTab;
    renderPage();
  }));
  const search = document.querySelector('#invoice-search');
  search?.addEventListener('input', () => {
    const cursor = search.selectionStart;
    searchTerm = search.value;
    renderPage();
    const next = document.querySelector('#invoice-search'); next?.focus(); next?.setSelectionRange(cursor, cursor);
  });
  const invoiceForm = document.querySelector('#invoice-form');
  if (invoiceForm) {
    invoiceForm.addEventListener('input', updateEditorTotals);
    invoiceForm.addEventListener('change', updateEditorTotals);
    invoiceForm.addEventListener('submit', event => { event.preventDefault(); if (invoiceForm.reportValidity()) saveInvoiceFromForm(invoiceForm); });
    updateEditorTotals();
  }
  document.querySelector('#settings-form')?.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    state.profile = { ...state.profile, name: String(data.get('name')).trim(), address: String(data.get('address')).trim(), taxId: String(data.get('taxId')).trim(), invoicePrefix: String(data.get('invoicePrefix')).trim() || 'INV', currency: String(data.get('currency')), paypalEmail: String(data.get('paypalEmail')).trim(), bankDetails: String(data.get('bankDetails')).trim() };
    saveState(); render(); showToast('Business profile saved.');
  });
  document.querySelector('#stock-form')?.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get('name')).trim();
    const found = state.inventory.find(item => item.name.toLowerCase() === name.toLowerCase());
    if (found) { found.stock = Number(data.get('stock')) || 0; found.price = Number(data.get('price')) || found.price; }
    else state.inventory.push({ name, stock: Number(data.get('stock')) || 0, price: Number(data.get('price')) || 0 });
    saveState(); render(); showToast('Inventory updated.');
  });
  document.querySelector('#expense-form')?.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const category = String(data.get('category') || 'General');
    state.expenses.push({
      id: crypto.randomUUID(),
      description: String(data.get('description')).trim(),
      amount: Number(data.get('amount')) || 0,
      category,
      date: new Date(`${data.get('date')}T12:00:00`).getTime(),
      isCogs: category === 'COGS' ? 1 : 0
    });
    saveState();
    renderPage();
    showToast('Expense added; syncing to Firebase.');
  });
}

async function handleAction(button) {
  const action = button.dataset.action;
  if (action === 'new-invoice') startNewInvoice();
  if (action === 'open-expenses') { currentPage = 'inventory'; inventoryTab = 'expenses'; render(); }
  if (action === 'back') { currentPage = 'invoices'; activeInvoiceId = null; render(); }
  if (action === 'add-line') {
    const showDiscount = Boolean(state.profile.discountEnabled) || Boolean(document.querySelector('.invoice-line .discount-control'));
    document.querySelector('#invoice-items').insertAdjacentHTML('beforeend', lineItemHtml({}, showDiscount, !state.profile.discountEnabled));
    updateEditorTotals();
  }
  if (action === 'toggle-line-discount') {
    const amountMode = button.dataset.amount !== 'true';
    button.dataset.amount = String(amountMode);
    button.textContent = amountMode ? state.profile.currency : '%';
    button.closest('.invoice-line').dataset.discountAmt = String(amountMode);
    updateEditorTotals();
  }
  if (action === 'toggle-total-discount') {
    const amountMode = button.dataset.amount !== 'true';
    button.dataset.amount = String(amountMode);
    button.textContent = amountMode ? state.profile.currency : '%';
    updateEditorTotals();
  }
  if (action === 'remove-line') { if (document.querySelectorAll('.invoice-line').length > 1) { button.closest('.invoice-line').remove(); updateEditorTotals(); } }
  if (action === 'open-invoice') openInvoice(button.dataset.id);
  if (action === 'toggle-invoice-status') {
    const invoice = state.invoices.find(item => item.id === button.dataset.id);
    if (!invoice) return;
    const isPaid = invoiceTotal(invoice) > 0 && Number(invoice.amountPaid) >= invoiceTotal(invoice);
    invoice.amountPaid = isPaid ? 0 : invoiceTotal(invoice);
    invoice.isPaid = !isPaid;
    saveState();
    render();
    showToast(`Invoice marked ${isPaid ? 'unpaid' : 'paid'}; syncing to Firebase.`);
  }
  if (action === 'edit-invoice') { currentPage = 'editor'; render(); }
  if (action === 'print-invoice') window.print();
  if (action === 'share-invoice') shareInvoice();
  if (action === 'delete-stock') {
    const item = state.inventory[Number(button.dataset.index)];
    if (!item) return;
    try {
      await deleteDoc(doc(db, 'users', currentUser.uid, 'stock', item.name));
      state.inventory.splice(Number(button.dataset.index), 1);
      saveState(); render(); showToast('Inventory item deleted and synced.');
    } catch (error) {
      showToast(`Could not delete inventory item: ${error.message}`);
    }
  }
  if (action === 'delete-expense') {
    const expense = state.expenses.find(item => item.id === button.dataset.id);
    if (!expense) return;
    try {
      await deleteDoc(doc(db, 'users', currentUser.uid, 'expenses', expense.id));
      state.expenses = state.expenses.filter(item => item.id !== expense.id);
      saveState(); renderPage(); showToast('Expense deleted and synced.');
    } catch (error) {
      showToast(`Could not delete expense: ${error.message}`);
    }
  }
  if (action === 'switch-account') signOut(auth);
  if (action === 'clear-data' && window.confirm('Clear this browser’s local cache? Cloud data in Firebase will remain.')) { localStorage.removeItem(`${STORAGE_KEY}:${currentUser.uid}`); state = structuredClone(initialState); currentPage = 'overview'; render(); showToast('Local cache cleared. Your Firebase data is unchanged.'); }
}

setPersistence(auth, browserLocalPersistence)
  .catch(error => console.error('Could not enable persistent sign-in:', error))
  .then(() => onAuthStateChanged(auth, user => {
    if (!user) {
      currentUser = null;
      state = structuredClone(initialState);
      authMode = 'signin';
      renderAuth();
      return;
    }
    void startAppForUser(user);
  }));