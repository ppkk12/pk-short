// @ts-check
/**
 * PK Short — 画面のクライアントスクリプト。
 *
 * - 誰でもログインなしで短縮URLを作成でき、作成履歴はこのブラウザの localStorage に保存する。
 * - 管理者はログインすると、すべての短縮URLの一覧・削除ができる。
 * - 秘密情報は一切持たない。管理者の認証は HttpOnly Cookie（サーバーが発行）で行う。
 * - ユーザー入力やAPIの値は textContent / 属性でのみDOMに入れ、HTMLとして挿入しない。
 */

/**
 * @typedef {object} Link
 * @property {number} id
 * @property {string} slug
 * @property {string} shortUrl
 * @property {string} destinationUrl
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {number} clickCount
 */

/**
 * @typedef {object} HistoryItem
 * @property {string} slug
 * @property {string} shortUrl
 * @property {string} destinationUrl
 * @property {string} createdAt
 */

/**
 * @typedef {object} LinkPage
 * @property {Link[]} links
 * @property {number} total
 * @property {number | null} nextCursor
 */

/**
 * @typedef {object} Session
 * @property {boolean} authConfigured
 * @property {boolean} authenticated
 * @property {boolean} publicCreate
 */

const SLUG_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const PUBLIC_SLUG_MIN_LENGTH = 4;
const HISTORY_KEY = "pk-short:history:v1";
const HISTORY_LIMIT = 200;
const dateFormatter = new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" });
const numberFormatter = new Intl.NumberFormat("ja-JP");

/**
 * @template {HTMLElement} T
 * @param {string} id
 * @param {new () => T} type
 * @returns {T}
 */
function byId(id, type) {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`#${id} が見つかりません`);
  return element;
}

const ui = {
  views: {
    loading: byId("view-loading", HTMLElement),
    login: byId("view-login", HTMLElement),
    app: byId("view-app", HTMLDivElement),
  },
  loadingMessage: byId("loading-message", HTMLParagraphElement),
  retryButton: byId("retry-button", HTMLButtonElement),
  adminBadge: byId("admin-badge", HTMLSpanElement),
  adminButton: byId("admin-button", HTMLButtonElement),
  logoutButton: byId("logout-button", HTMLButtonElement),

  loginUnconfigured: byId("login-unconfigured", HTMLDivElement),
  loginForm: byId("login-form", HTMLFormElement),
  loginBackOnly: byId("login-back-only", HTMLParagraphElement),
  tokenInput: byId("token-input", HTMLInputElement),
  tokenError: byId("token-error", HTMLParagraphElement),
  loginButton: byId("login-button", HTMLButtonElement),
  loginBackButtons: [byId("login-back", HTMLButtonElement), byId("login-back-2", HTMLButtonElement)],

  publicDisabled: byId("public-disabled", HTMLParagraphElement),
  createForm: byId("create-form", HTMLFormElement),
  urlInput: byId("url-input", HTMLInputElement),
  urlError: byId("url-error", HTMLParagraphElement),
  slugInput: byId("slug-input", HTMLInputElement),
  slugHint: byId("slug-hint", HTMLParagraphElement),
  slugError: byId("slug-error", HTMLParagraphElement),
  createButton: byId("create-button", HTMLButtonElement),
  createError: byId("create-error", HTMLParagraphElement),

  result: byId("result", HTMLDivElement),
  resultUrl: byId("result-url", HTMLAnchorElement),
  resultCopy: byId("result-copy", HTMLButtonElement),
  resultDestination: byId("result-destination", HTMLSpanElement),

  historySection: byId("history-section", HTMLElement),
  historyCount: byId("history-count", HTMLParagraphElement),
  historyList: byId("history-list", HTMLOListElement),
  historyEmpty: byId("history-empty", HTMLDivElement),

  adminSection: byId("admin-section", HTMLElement),
  linksCount: byId("links-count", HTMLParagraphElement),
  linksStatus: byId("links-status", HTMLDivElement),
  linksStatusMessage: byId("links-status-message", HTMLParagraphElement),
  linksRetry: byId("links-retry", HTMLButtonElement),
  linkList: byId("link-list", HTMLOListElement),
  linksEmpty: byId("links-empty", HTMLDivElement),
  loadMore: byId("load-more", HTMLButtonElement),
  rowTemplate: byId("link-row-template", HTMLTemplateElement),

  deleteDialog: byId("delete-dialog", HTMLDialogElement),
  deleteTarget: byId("delete-target", HTMLElement),
  deleteError: byId("delete-error", HTMLParagraphElement),
  deleteCancel: byId("delete-cancel", HTMLButtonElement),
  deleteConfirm: byId("delete-confirm", HTMLButtonElement),

  toast: byId("toast", HTMLDivElement),
};

const state = {
  /** @type {Session} */
  session: { authConfigured: false, authenticated: false, publicCreate: true },
  /** @type {HistoryItem[]} */
  history: [],
  /** @type {Link[]} */
  links: [],
  total: 0,
  /** @type {number | null} */
  nextCursor: null,
  loadingLinks: false,
  /** @type {{ link: Link, trigger: HTMLElement } | null} */
  pendingDelete: null,
};

/* ---------------------------------------------------------------- API */

class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {string | undefined} field
   */
  constructor(status, code, message, field) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [options]
 * @returns {Promise<any>}
 */
async function api(path, options = {}) {
  /** @type {Record<string, string>} */
  const headers = { Accept: "application/json" };
  /** @type {RequestInit} */
  const init = { method: options.method ?? "GET", headers, credentials: "same-origin", cache: "no-store" };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  /** @type {Response} */
  let response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError(0, "network_error", "サーバーに接続できませんでした。ネットワーク接続を確認してください。", undefined);
  }
  if (response.status === 204) return null;

  /** @type {any} */
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const error = data && typeof data === "object" ? data.error : null;
    const apiError = new ApiError(
      response.status,
      typeof error?.code === "string" ? error.code : "unknown",
      typeof error?.message === "string" ? error.message : `エラーが発生しました（HTTP ${response.status}）。`,
      typeof error?.field === "string" ? error.field : undefined,
    );
    // 管理APIで 401 が返ったらセッション切れとみなして一般モードに戻す。
    if (response.status === 401 && path !== "/api/session" && state.session.authenticated) handleSessionExpired();
    throw apiError;
  }
  return data;
}

/* ---------------------------------------------------------------- 画面切り替え */

/** @param {"loading" | "login" | "app"} name */
function showView(name) {
  for (const [key, element] of Object.entries(ui.views)) {
    element.hidden = key !== name;
  }
}

function isAdmin() {
  return state.session.authenticated;
}

/** 管理者かどうか・一般作成の可否に合わせて画面を切り替える。 */
function applyMode() {
  const admin = isAdmin();
  const canCreate = admin || state.session.publicCreate;

  ui.adminBadge.hidden = !admin;
  ui.adminButton.hidden = admin;
  ui.logoutButton.hidden = !admin;
  ui.adminSection.hidden = !admin;
  ui.historySection.hidden = admin;

  ui.publicDisabled.hidden = canCreate;
  for (const element of ui.createForm.elements) {
    if (element instanceof HTMLInputElement || element instanceof HTMLButtonElement) element.disabled = !canCreate;
  }

  const min = admin ? 1 : PUBLIC_SLUG_MIN_LENGTH;
  ui.slugHint.textContent = `半角英数字と - _ で${min}〜40文字（大文字・小文字は区別）。空欄なら自動で決まります。`;

  if (admin) {
    void loadLinks({ reset: true });
  } else {
    renderHistory();
  }
}

async function boot() {
  showView("loading");
  ui.loadingMessage.textContent = "読み込み中…";
  ui.retryButton.hidden = true;
  try {
    state.session = await api("/api/session");
    state.history = loadHistory();
    showView("app");
    applyMode();
    if (location.hash === "#admin" && !isAdmin()) showLogin();
  } catch (error) {
    ui.loadingMessage.textContent = messageOf(error);
    ui.retryButton.hidden = false;
  }
}

function showLogin() {
  const configured = state.session.authConfigured;
  ui.loginUnconfigured.hidden = configured;
  ui.loginForm.hidden = !configured;
  ui.loginBackOnly.hidden = configured;
  showView("login");
  if (configured) ui.tokenInput.focus();
}

function backToApp() {
  clearFieldError(ui.tokenInput, ui.tokenError);
  ui.tokenInput.value = "";
  if (location.hash === "#admin") history.replaceState(null, "", location.pathname);
  showView("app");
  ui.urlInput.focus();
}

function handleSessionExpired() {
  state.session.authenticated = false;
  resetAdminState();
  applyMode();
  toast("ログインの有効期限が切れました。もう一度ログインしてください。", "error");
}

function resetAdminState() {
  state.links = [];
  state.total = 0;
  state.nextCursor = null;
  renderLinks();
}

/* ---------------------------------------------------------------- 管理者ログイン */

ui.adminButton.addEventListener("click", () => showLogin());
for (const button of ui.loginBackButtons) button.addEventListener("click", () => backToApp());

ui.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearFieldError(ui.tokenInput, ui.tokenError);
  const token = ui.tokenInput.value.trim();
  if (token === "") {
    setFieldError(ui.tokenInput, ui.tokenError, "管理トークンを入力してください。");
    ui.tokenInput.focus();
    return;
  }

  setBusy(ui.loginButton, true, "確認中…");
  try {
    await api("/api/session", { method: "POST", body: { token } });
    state.session.authenticated = true;
    backToApp();
    applyMode();
    toast("管理者としてログインしました");
  } catch (error) {
    setFieldError(ui.tokenInput, ui.tokenError, messageOf(error));
    ui.tokenInput.select();
  } finally {
    setBusy(ui.loginButton, false);
  }
});

ui.logoutButton.addEventListener("click", async () => {
  setBusy(ui.logoutButton, true, "ログアウト中…");
  try {
    await api("/api/session", { method: "DELETE" });
    state.session.authenticated = false;
    resetAdminState();
    applyMode();
    toast("ログアウトしました");
  } catch (error) {
    toast(messageOf(error), "error");
  } finally {
    setBusy(ui.logoutButton, false);
  }
});

ui.retryButton.addEventListener("click", () => void boot());

/* ---------------------------------------------------------------- 作成フォーム */

ui.createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearCreateErrors();

  const url = ui.urlInput.value.trim();
  const slug = ui.slugInput.value.trim();
  const minSlugLength = isAdmin() ? 1 : PUBLIC_SLUG_MIN_LENGTH;
  /** @type {HTMLInputElement | null} */
  let firstInvalid = null;

  if (url === "") {
    setFieldError(ui.urlInput, ui.urlError, "短縮したいURLを入力してください。");
    firstInvalid = ui.urlInput;
  } else if (!/^https?:\/\//i.test(url)) {
    setFieldError(ui.urlInput, ui.urlError, "http:// または https:// で始まるURLを入力してください。");
    firstInvalid = ui.urlInput;
  }
  if (slug !== "" && (!SLUG_PATTERN.test(slug) || slug.length < minSlugLength)) {
    setFieldError(
      ui.slugInput,
      ui.slugError,
      `カスタムURLは半角英数字・ハイフン（-）・アンダースコア（_）の${minSlugLength}〜40文字で指定してください。`,
    );
    firstInvalid ??= ui.slugInput;
  }
  if (firstInvalid) {
    firstInvalid.focus();
    return;
  }

  setBusy(ui.createButton, true, "短縮中…");
  try {
    /** @type {{ link: Link }} */
    const { link } = await api("/api/links", {
      method: "POST",
      body: slug === "" ? { url } : { url, slug },
    });
    showResult(link);
    ui.createForm.reset();
    addToHistory(link);
    if (isAdmin()) {
      state.links = [link, ...state.links.filter((item) => item.id !== link.id)];
      state.total += 1;
      renderLinks(link.id);
    } else {
      renderHistory(link.shortUrl);
    }
    toast("短縮URLを作成しました");
  } catch (error) {
    const message = messageOf(error);
    const field = error instanceof ApiError ? error.field : undefined;
    if (field === "url") {
      setFieldError(ui.urlInput, ui.urlError, message);
      ui.urlInput.focus();
    } else if (field === "slug") {
      setFieldError(ui.slugInput, ui.slugError, message);
      ui.slugInput.focus();
    } else {
      ui.createError.textContent = message;
      ui.createError.hidden = false;
      if (error instanceof ApiError && error.code === "public_create_disabled") {
        state.session.publicCreate = false;
        applyMode();
      }
    }
  } finally {
    setBusy(ui.createButton, false);
  }
});

ui.createForm.addEventListener("reset", () => {
  clearCreateErrors();
});

for (const [input, error] of /** @type {const} */ ([
  [ui.urlInput, ui.urlError],
  [ui.slugInput, ui.slugError],
])) {
  input.addEventListener("input", () => clearFieldError(input, error));
}

function clearCreateErrors() {
  clearFieldError(ui.urlInput, ui.urlError);
  clearFieldError(ui.slugInput, ui.slugError);
  ui.createError.hidden = true;
  ui.createError.textContent = "";
}

/** @param {Link} link */
function showResult(link) {
  ui.resultUrl.textContent = link.shortUrl;
  ui.resultUrl.href = link.shortUrl;
  ui.resultDestination.textContent = link.destinationUrl;
  ui.result.hidden = false;
  ui.resultCopy.onclick = () => void copyFromButton(ui.resultCopy, link.shortUrl);
}

/* ---------------------------------------------------------------- このデバイスの履歴 */

/** @returns {HistoryItem[]} */
function loadHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isHistoryItem).slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

function saveHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history));
  } catch {
    // プライベートブラウズなどで保存できない場合は、このページを開いている間だけ保持する。
  }
}

/**
 * @param {unknown} value
 * @returns {value is HistoryItem}
 */
function isHistoryItem(value) {
  if (typeof value !== "object" || value === null) return false;
  const item = /** @type {Record<string, unknown>} */ (value);
  return (
    typeof item.slug === "string" &&
    typeof item.shortUrl === "string" &&
    typeof item.destinationUrl === "string" &&
    typeof item.createdAt === "string" &&
    /^https?:\/\//.test(item.shortUrl)
  );
}

/** @param {Link} link */
function addToHistory(link) {
  /** @type {HistoryItem} */
  const item = {
    slug: link.slug,
    shortUrl: link.shortUrl,
    destinationUrl: link.destinationUrl,
    createdAt: link.createdAt,
  };
  state.history = [item, ...state.history.filter((entry) => entry.shortUrl !== item.shortUrl)].slice(
    0,
    HISTORY_LIMIT,
  );
  saveHistory();
}

/** @param {string} [highlightShortUrl] */
function renderHistory(highlightShortUrl) {
  const rows = state.history.map((item) =>
    createRow(item, {
      isNew: item.shortUrl === highlightShortUrl,
      clickCount: null,
      removeLabel: "履歴から消す",
      onRemove: (button) => removeFromHistory(item, button),
    }),
  );
  ui.historyList.replaceChildren(...rows);
  ui.historyEmpty.hidden = state.history.length > 0;
  ui.historyCount.textContent = state.history.length > 0 ? `${numberFormatter.format(state.history.length)} 件` : "";
  requestAnimationFrame(updateExpandButtons);
}

/**
 * @param {HistoryItem} item
 * @param {HTMLElement} trigger
 */
function removeFromHistory(item, trigger) {
  const index = state.history.findIndex((entry) => entry.shortUrl === item.shortUrl);
  state.history = state.history.filter((entry) => entry.shortUrl !== item.shortUrl);
  saveHistory();
  renderHistory();
  toast("履歴から消しました（短縮URLは引き続き使えます）");
  focusRowAction(ui.historyList, index, trigger);
}

/* ---------------------------------------------------------------- 管理者の一覧 */

/** @param {{ reset: boolean }} options */
async function loadLinks({ reset }) {
  if (state.loadingLinks) return;
  state.loadingLinks = true;
  ui.linkList.setAttribute("aria-busy", "true");
  if (reset) {
    setLinksStatus("読み込み中…");
  } else {
    setBusy(ui.loadMore, true, "読み込み中…");
  }

  try {
    const params = new URLSearchParams();
    if (!reset && state.nextCursor !== null) params.set("cursor", String(state.nextCursor));
    const query = params.toString();
    /** @type {LinkPage} */
    const page = await api(`/api/links${query ? `?${query}` : ""}`);
    const known = new Set(reset ? [] : state.links.map((link) => link.id));
    state.links = reset ? page.links : [...state.links, ...page.links.filter((link) => !known.has(link.id))];
    state.total = page.total;
    state.nextCursor = page.nextCursor;
    setLinksStatus(null);
    renderLinks();
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) {
      setLinksStatus(`一覧を読み込めませんでした。${messageOf(error)}`, true);
    }
  } finally {
    state.loadingLinks = false;
    ui.linkList.setAttribute("aria-busy", "false");
    setBusy(ui.loadMore, false);
  }
}

/**
 * @param {string | null} message
 * @param {boolean} [isError]
 */
function setLinksStatus(message, isError = false) {
  ui.linksStatus.hidden = message === null;
  ui.linksStatus.classList.toggle("is-error", isError);
  ui.linksStatusMessage.textContent = message ?? "";
  ui.linksRetry.hidden = !isError;
}

ui.linksRetry.addEventListener("click", () => void loadLinks({ reset: true }));
ui.loadMore.addEventListener("click", () => void loadLinks({ reset: false }));

/** @param {number} [highlightId] */
function renderLinks(highlightId) {
  const rows = state.links.map((link) =>
    createRow(link, {
      isNew: link.id === highlightId,
      clickCount: link.clickCount,
      removeLabel: "削除",
      onRemove: (button) => openDeleteDialog(link, button),
    }),
  );
  ui.linkList.replaceChildren(...rows);
  ui.linksEmpty.hidden = state.links.length > 0 || !ui.linksStatus.hidden;
  ui.linksCount.textContent = state.total > 0 ? `${numberFormatter.format(state.total)} 件` : "";
  ui.loadMore.hidden = state.nextCursor === null;
  requestAnimationFrame(updateExpandButtons);
}

/* ---------------------------------------------------------------- 行の描画 */

/**
 * @param {HistoryItem} item
 * @param {{ isNew: boolean, clickCount: number | null, removeLabel: string, onRemove: (button: HTMLButtonElement) => void }} options
 * @returns {HTMLLIElement}
 */
function createRow(item, options) {
  const fragment = /** @type {DocumentFragment} */ (ui.rowTemplate.content.cloneNode(true));
  const row = /** @type {HTMLLIElement} */ (fragment.firstElementChild);
  /**
   * @param {string} selector
   * @returns {any}
   */
  const query = (selector) => {
    const element = row.querySelector(selector);
    if (!element) throw new Error(`${selector} が見つかりません`);
    return element;
  };
  const display = displayShortUrl(item.shortUrl);

  row.dataset.key = item.shortUrl;
  row.classList.toggle("is-new", options.isNew);

  /** @type {HTMLAnchorElement} */
  const shortAnchor = query(".link-short");
  shortAnchor.textContent = display;
  shortAnchor.href = item.shortUrl;

  /** @type {HTMLAnchorElement} */
  const destination = query(".link-destination-url");
  destination.textContent = item.destinationUrl;
  destination.title = item.destinationUrl;
  if (/^https?:\/\//i.test(item.destinationUrl)) destination.href = item.destinationUrl;

  /** @type {HTMLButtonElement} */
  const expand = query(".link-expand");
  expand.setAttribute("aria-label", `${display} の転送先URLを全文表示`);
  expand.addEventListener("click", () => {
    const expanded = row.classList.toggle("is-expanded");
    expand.setAttribute("aria-expanded", String(expanded));
    expand.textContent = expanded ? "折りたたむ" : "全文";
  });

  /** @type {HTMLTimeElement} */
  const created = query(".link-created");
  created.dateTime = item.createdAt;
  created.textContent = formatDate(item.createdAt);

  if (options.clickCount === null) {
    query(".link-clicks-item").remove();
  } else {
    query(".link-clicks").textContent = numberFormatter.format(options.clickCount);
  }

  /** @type {HTMLButtonElement} */
  const copyButton = query(".link-copy");
  copyButton.setAttribute("aria-label", `${display} をコピー`);
  copyButton.addEventListener("click", () => void copyFromButton(copyButton, item.shortUrl));

  /** @type {HTMLButtonElement} */
  const removeButton = query(".link-remove");
  removeButton.textContent = options.removeLabel;
  removeButton.classList.toggle("button-danger-text", options.removeLabel === "削除");
  removeButton.setAttribute("aria-label", `${display} を${options.removeLabel}`);
  removeButton.addEventListener("click", () => options.onRemove(removeButton));

  return row;
}

/** 省略表示されている転送先URLにだけ「全文」ボタンを出す。 */
function updateExpandButtons() {
  for (const row of document.querySelectorAll(".link-row")) {
    if (row.classList.contains("is-expanded")) continue;
    const text = row.querySelector(".link-destination-url");
    const button = row.querySelector(".link-expand");
    if (text instanceof HTMLElement && button instanceof HTMLButtonElement) {
      button.hidden = text.scrollWidth <= text.clientWidth;
    }
  }
}

let resizeTimer = 0;
window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(updateExpandButtons, 150);
});

/**
 * 行を消した後、同じ位置（なければ1つ前）の行の操作ボタン、またはURL入力欄にフォーカスを移す。
 * @param {HTMLOListElement} list
 * @param {number} index
 * @param {HTMLElement} trigger
 */
function focusRowAction(list, index, trigger) {
  const rows = list.querySelectorAll(".link-row");
  const target = rows[Math.min(index, rows.length - 1)]?.querySelector(".link-remove");
  if (target instanceof HTMLElement) {
    target.focus();
  } else if (!trigger.isConnected) {
    ui.urlInput.focus();
  }
}

/* ---------------------------------------------------------------- 削除（管理者） */

/**
 * @param {Link} link
 * @param {HTMLElement} trigger
 */
function openDeleteDialog(link, trigger) {
  state.pendingDelete = { link, trigger };
  ui.deleteTarget.textContent = displayShortUrl(link.shortUrl);
  ui.deleteError.hidden = true;
  ui.deleteError.textContent = "";
  ui.deleteDialog.showModal();
}

ui.deleteCancel.addEventListener("click", () => ui.deleteDialog.close());

ui.deleteDialog.addEventListener("close", () => {
  const pending = state.pendingDelete;
  state.pendingDelete = null;
  // 削除されずに閉じた場合は、操作したボタンにフォーカスを戻す。
  if (pending && pending.trigger.isConnected) pending.trigger.focus();
});

ui.deleteConfirm.addEventListener("click", async () => {
  const pending = state.pendingDelete;
  if (!pending) return;
  const { link } = pending;

  setBusy(ui.deleteConfirm, true, "削除中…");
  ui.deleteCancel.disabled = true;
  try {
    await api(`/api/links/${encodeURIComponent(link.slug)}`, { method: "DELETE" });
    removeLinkFromList(link);
    toast(`${displayShortUrl(link.shortUrl)} を削除しました`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      removeLinkFromList(link);
      toast("このURLは既に削除されていました");
    } else if (!(error instanceof ApiError && error.status === 401)) {
      ui.deleteError.textContent = messageOf(error);
      ui.deleteError.hidden = false;
      return;
    } else {
      ui.deleteDialog.close();
    }
  } finally {
    setBusy(ui.deleteConfirm, false);
    ui.deleteCancel.disabled = false;
  }
});

/** @param {Link} link */
function removeLinkFromList(link) {
  const index = state.links.findIndex((item) => item.id === link.id);
  const trigger = state.pendingDelete?.trigger ?? ui.urlInput;
  state.links = state.links.filter((item) => item.id !== link.id);
  state.total = Math.max(0, state.total - 1);
  state.pendingDelete = null;
  ui.deleteDialog.close();
  renderLinks();
  focusRowAction(ui.linkList, index, trigger);
}

/* ---------------------------------------------------------------- コピー・通知 */

/**
 * @param {HTMLButtonElement} button
 * @param {string} text
 */
async function copyFromButton(button, text) {
  const copied = await copyText(text);
  if (!copied) {
    toast("コピーできませんでした。手動で選択してコピーしてください。", "error");
    return;
  }
  const original = button.dataset.label ?? button.textContent ?? "";
  button.dataset.label = original;
  button.textContent = "コピーしました";
  toast("短縮URLをコピーしました");
  window.setTimeout(() => {
    button.textContent = original;
    delete button.dataset.label;
  }, 1600);
}

/**
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API が使えない環境向けのフォールバック。
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    textarea.remove();
    return copied;
  }
}

let toastTimer = 0;
/**
 * @param {string} message
 * @param {"info" | "error"} [tone]
 */
function toast(message, tone = "info") {
  window.clearTimeout(toastTimer);
  ui.toast.textContent = message;
  ui.toast.classList.toggle("is-error", tone === "error");
  ui.toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => ui.toast.classList.remove("is-visible"), tone === "error" ? 5000 : 2400);
}

/* ---------------------------------------------------------------- ユーティリティ */

/**
 * @param {HTMLInputElement} input
 * @param {HTMLElement} errorElement
 * @param {string} message
 */
function setFieldError(input, errorElement, message) {
  input.setAttribute("aria-invalid", "true");
  errorElement.textContent = message;
  errorElement.hidden = false;
}

/**
 * @param {HTMLInputElement} input
 * @param {HTMLElement} errorElement
 */
function clearFieldError(input, errorElement) {
  input.removeAttribute("aria-invalid");
  errorElement.textContent = "";
  errorElement.hidden = true;
}

/**
 * @param {HTMLButtonElement} button
 * @param {boolean} busy
 * @param {string} [label]
 */
function setBusy(button, busy, label) {
  if (busy) {
    button.dataset.idleLabel = button.textContent ?? "";
    if (label) button.textContent = label;
  } else if (button.dataset.idleLabel !== undefined) {
    button.textContent = button.dataset.idleLabel;
    delete button.dataset.idleLabel;
  }
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error && error.message ? error.message : "予期しないエラーが発生しました。";
}

/** @param {string} shortUrl */
function displayShortUrl(shortUrl) {
  return shortUrl.replace(/^https?:\/\//, "");
}

/** @param {string} iso */
function formatDate(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateFormatter.format(date);
}

/* ---------------------------------------------------------------- 起動 */

for (const element of document.querySelectorAll("[data-host]")) {
  element.textContent = location.host;
}
for (const element of document.querySelectorAll("[data-prefix]")) {
  element.textContent = `${location.host}/`;
}

void boot();
