/**
 * ============================================================================
 * Frontend Core
 * ----------------------------------------------------------------------------
 * 役割:
 * - 画面状態と DOM 参照を定義する
 * - LIFF 初期化と初回ロードを行う
 * - 一覧/詳細/履歴のロード単位で state を同期する
 * ============================================================================
 */

const STATUS_OPTIONS = {
  bug: ['🆕OPEN', '🚧IN_PROGRESS', '✅DONE', '✋HOLD'],
  task: ['📝TODO', '🚧IN_PROGRESS', '✅DONE', '✋HOLD'],
};
const PRIORITY_OPTIONS = ['🟢LOW', '🟡MEDIUM', '🔴HIGH'];
const STATUS_NOTIFY_SUFFIX = '(LINE通知)';
const DETAIL_EMPTY_MESSAGE = '一覧から項目を選ぶとここに詳細が出ます。';
const DETAIL_EMPTY_NO_RECORDS_MESSAGE = '表示対象の未完了データはありません。';
const DETAIL_EMPTY_HISTORY_MESSAGE = '履歴は一覧で確認できます。';
const DEFAULT_LIST_LIMIT = 12;
const FILTERED_LIST_LIMIT = 40;

/**
 * 画面状態
 * API 結果と UI 操作を同じ場所で追えるように 1 つの state に寄せる。
 */
const state = {
  entity: getInitialEntity_(),
  view: getInitialView_(),
  selectedId: getQueryParam_('id') || '',
  statusFilter: '',
  priorityFilter: '',
  records: [],
  summary: null,
  histories: [],
  detail: null,
  links: {},
  profileId: '',
  profileName: '',
  profilePictureUrl: '',
  accessToken: '',
  loadingCount: 0,
  errorMessage: '',
  listErrorMessage: '',
  summaryErrorMessage: '',
};

const elements = {
  layout: document.querySelector('.layout'),
  entityButtons: Array.from(document.querySelectorAll('[data-entity]')),
  listMount: document.getElementById('listMount'),
  summaryMount: document.getElementById('summaryMount'),
  summaryPanel: document.getElementById('summaryPanel'),
  summaryHeading: document.getElementById('summaryHeading'),
  summarySubheading: document.getElementById('summarySubheading'),
  listPanel: document.getElementById('listPanel'),
  listHeading: document.getElementById('listHeading'),
  listSubheading: document.getElementById('listSubheading'),
  detailMount: document.getElementById('detailMount'),
  detailPanel: document.getElementById('detailPanel'),
  detailOverlay: document.getElementById('detailOverlay'),
  detailCloseButton: document.getElementById('detailCloseButton'),
  reloadButton: document.getElementById('reloadButton'),
  sheetButton: document.getElementById('sheetButton'),
  profileAnchor: document.getElementById('profileAnchor'),
  profileButton: document.getElementById('profileButton'),
  profileAvatar: document.getElementById('profileAvatar'),
  profileFallback: document.getElementById('profileFallback'),
  profileMenu: document.getElementById('profileMenu'),
  profileName: document.getElementById('profileName'),
  logoutButton: document.getElementById('logoutButton'),
  loadingOverlay: document.getElementById('loadingOverlay'),
  loadingLabel: document.getElementById('loadingLabel'),
};

/**
 * 初期化入口
 * イベント購読、URL同期、LIFF初期化、初回ロードを順に行う。
 */
async function initialize_() {
  bindEvents_();
  updateNavigationState_();
  const ready = await initializeLiff_();
  if (ready === false) return;
  await loadCurrentView_();
}

/**
 * UI イベントを購読する
 * 画面遷移前に未保存確認が必要なものはここで統一的に扱う。
 */
function bindEvents_() {
  elements.entityButtons.forEach(button => {
    button.addEventListener('click', async function () {
      if (!confirmDetailDiscardIfNeeded_()) return;
      updateNavigationState_({
        entity: button.dataset.entity || 'bug',
        view: 'dashboard',
        selectedId: '',
        detail: null,
        statusFilter: '',
        priorityFilter: '',
      });
      await loadCurrentView_();
    });
  });

  elements.reloadButton.addEventListener('click', function () {
    if (!confirmDetailDiscardIfNeeded_()) return;
    if (state.view !== 'dashboard') {
      updateNavigationState_({ view: 'dashboard' });
    }
    loadCurrentView_().catch(showFatalError_);
  });

  if (elements.sheetButton) {
    elements.sheetButton.addEventListener('click', function () {
      openSheet_().catch(showFatalError_);
    });
  }

  if (elements.detailOverlay) {
    elements.detailOverlay.addEventListener('click', function () {
      requestDetailClose_();
    });
  }

  if (elements.detailCloseButton) {
    elements.detailCloseButton.addEventListener('click', function () {
      requestDetailClose_();
    });
  }

  if (elements.profileButton) {
    elements.profileButton.addEventListener('click', function (event) {
      event.stopPropagation();
      toggleProfileMenu_();
    });
  }

  if (elements.profileMenu) {
    elements.profileMenu.addEventListener('click', function (event) {
      event.stopPropagation();
    });
  }

  if (elements.logoutButton) {
    elements.logoutButton.addEventListener('click', function () {
      logoutFromLiff_().catch(showFatalError_);
    });
  }

  document.addEventListener('click', function () {
    setProfileMenuOpen_(false);
  });
}

async function initializeLiff_() {
  const liffId = (window.APP_CONFIG && window.APP_CONFIG.liffId) || '';
  if (!window.liff || !liffId) return true;

  await window.liff.init({ liffId: liffId });

  if (!window.liff.isLoggedIn()) {
    if (typeof window.liff.login === 'function') {
      window.liff.login({ redirectUri: window.location.href });
      return false;
    }
    throw new Error('LINEログインが必要です。');
  }

  const profile = await window.liff.getProfile();
  state.profileId = profile.userId || '';
  state.profileName = profile.displayName || '';
  state.profilePictureUrl = profile.pictureUrl || '';
  state.accessToken = typeof window.liff.getAccessToken === 'function'
    ? String(window.liff.getAccessToken() || '')
    : '';
  syncProfileUi_();
  return true;
}

async function loadCurrentView_() {
  try {
    if (state.view === 'history') {
      await loadHistoryView_();
      return;
    }

    const results = await Promise.allSettled([
      requestApi_(buildListRequestParams_()),
      requestApi_({ api: 'summary', entity: state.entity, limit: 6 }),
    ]);
    applyDashboardResults_(results[0], results[1]);

    if (state.listErrorMessage && state.summaryErrorMessage) {
      throw new Error(state.listErrorMessage);
    }

    renderDashboardView_();

    if (state.selectedId) {
      await openDetail_(state.selectedId);
      return;
    }

    showDetailEmptyState_();
  } catch (error) {
    applyLoadErrorState_(error);
  }
}

/**
 * 履歴専用ビューを読み込む
 */
async function loadHistoryView_() {
  try {
    const payload = await requestApi_({ api: 'history', limit: 20 });
    resetLoadMessages_();
    state.histories = payload.data.histories || [];
    state.summary = null;
    state.records = [];
    state.links = Object.assign({}, payload.data.links || {});

    renderHistoryView_();
    syncSheetButtonState_();
    renderEmptyDetail_(DETAIL_EMPTY_HISTORY_MESSAGE);
    clearDetailSelection_();
  } catch (error) {
    applyLoadErrorState_(error);
  }
}

/**
 * 詳細を読み込んで右パネル/シートを開く
 *
 * @param {string} itemId
 * @returns {Promise<void>}
 */
async function openDetail_(itemId) {
  if (!confirmDetailDiscardIfNeeded_(itemId)) {
    return;
  }

  const payload = await requestApi_({
    api: 'detail',
    entity: state.entity,
    id: itemId,
  });

  setDetailRecord_(payload.data.record, itemId);
  renderList_();
  renderDetail_();
  setDetailOpen_(true);
}

/**
 * ダッシュボード全体の描画更新
 * summary/list/sheet link を 1 箇所で同期する。
 */
function renderDashboardView_() {
  setPanelVisibility_(true);
  syncSectionHeadings_();
  renderSummary_();
  renderList_();
  syncSheetButtonState_();
}

/**
 * 一覧・集計 API の結果を state に反映する
 *
 * @param {PromiseSettledResult<Object>} listResult
 * @param {PromiseSettledResult<Object>} summaryResult
 */
function applyDashboardResults_(listResult, summaryResult) {
  resetLoadMessages_();
  state.histories = [];
  state.links = {};

  if (listResult.status === 'fulfilled') {
    state.records = listResult.value.data.records || [];
    state.links = Object.assign({}, state.links, listResult.value.data.links || {});
  } else {
    state.records = [];
    state.listErrorMessage = getErrorMessage_(listResult.reason, '一覧の読み込みに失敗しました。');
  }

  if (summaryResult.status === 'fulfilled') {
    state.summary = summaryResult.value.data;
    state.links = Object.assign({}, state.links, summaryResult.value.data.links || {});
  } else {
    state.summary = null;
    state.summaryErrorMessage = getErrorMessage_(summaryResult.reason, '集計の読み込みに失敗しました。');
  }
}

function resetLoadMessages_() {
  state.errorMessage = '';
  state.listErrorMessage = '';
  state.summaryErrorMessage = '';
}

function setDetailOpen_(isOpen) {
  if (!elements.detailPanel || !elements.detailOverlay) return;

  elements.detailPanel.classList.toggle('is-open', !!isOpen);
  elements.detailOverlay.classList.toggle('is-open', !!isOpen);
  elements.detailPanel.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
  if (elements.layout) {
    elements.layout.classList.toggle('has-detail-open', !!isOpen);
  }
}

function syncButtonState_() {
  elements.entityButtons.forEach(button => {
    button.classList.toggle('is-active', button.dataset.entity === state.entity);
    button.setAttribute('aria-selected', button.dataset.entity === state.entity ? 'true' : 'false');
  });
}

function updateNavigationState_(nextState) {
  Object.assign(state, nextState || {});
  syncButtonState_();
  syncSectionHeadings_();
  syncUrl_();
}

/**
 * 現在の record を詳細表示中の state として保存する
 *
 * @param {Object} record
 * @param {string} itemId
 */
function setDetailRecord_(record, itemId) {
  updateNavigationState_({
    detail: record,
    selectedId: itemId || (record && record.id) || '',
  });
}

/**
 * 詳細選択をクリアする
 * 閉じる時の state reset を一箇所へ寄せる。
 */
function clearDetailSelection_() {
  updateNavigationState_({
    selectedId: '',
    detail: null,
  });
  setDetailOpen_(false);
}
