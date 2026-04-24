/**
 * ============================================================================
 * Frontend Actions
 * ----------------------------------------------------------------------------
 * 役割:
 * - API 通信と保存処理を行う
 * - フィルター、未保存確認、表示補助の utility をまとめる
 * - シート起動やプロフィールメニューなどの UI アクションを扱う
 * ============================================================================
 */

function objectEntries_(value) {
  return Object.entries(value || {});
}

function orderPriorityEntries_(value) {
  const entries = objectEntries_(value);
  const rank = ['LOW', 'MEDIUM', 'HIGH'];

  return entries.sort(function (a, b) {
    return rank.indexOf(stripPriorityLabel_(a[0])) - rank.indexOf(stripPriorityLabel_(b[0]));
  });
}

function getFilteredRecords_() {
  const records = (state.records || []).slice();
  return records.filter(function (record) {
    return isRecordMatchedByFilter_(record, 'status', state.statusFilter) &&
      isRecordMatchedByFilter_(record, 'priority', state.priorityFilter);
  });
}

function getInitialEntity_() {
  const query = getQueryParam_('entity');
  if (query === 'task') return 'task';
  return ((window.APP_CONFIG && window.APP_CONFIG.defaultEntity) || 'bug') === 'task' ? 'task' : 'bug';
}

function getInitialView_() {
  return getQueryParam_('view') === 'history' ? 'history' : 'dashboard';
}

function getStatusOptions_(entityType) {
  return (STATUS_OPTIONS[entityType] || STATUS_OPTIONS.bug).map(toOption_);
}

function getPriorityOptions_() {
  return PRIORITY_OPTIONS.map(toOption_);
}

function getQueryParam_(name) {
  return new URLSearchParams(window.location.search).get(name) || '';
}

function syncUrl_() {
  const url = new URL(window.location.href);
  url.searchParams.set('entity', state.entity);
  if (state.view === 'history') {
    url.searchParams.set('view', 'history');
  } else {
    url.searchParams.delete('view');
  }

  if (state.selectedId) {
    url.searchParams.set('id', state.selectedId);
  } else {
    url.searchParams.delete('id');
  }

  window.history.replaceState({}, '', url.toString());
}

async function toggleSort_(sortType, sortValue) {
  const nextState = { view: 'dashboard' };

  if (sortType === 'status') {
    nextState.statusFilter = state.statusFilter === sortValue ? '' : sortValue;
  } else if (sortType === 'priority') {
    nextState.priorityFilter = state.priorityFilter === sortValue ? '' : sortValue;
  }

  updateNavigationState_(nextState);
  await loadCurrentView_();
}

function syncSectionHeadings_() {
  if (!elements.listHeading || !elements.listSubheading || !elements.summaryHeading || !elements.summarySubheading) {
    return;
  }

  if (state.view === 'history') {
    elements.listHeading.textContent = '最新変更';
    elements.listSubheading.textContent = '新しい更新から表示';
    elements.summaryHeading.textContent = '集計';
    elements.summarySubheading.textContent = 'チップをタップして一覧を絞り込み';
    return;
  }

  elements.listHeading.textContent = '一覧';
  elements.listSubheading.textContent = hasActiveRecordFilters_()
    ? `状態×優先度の条件に合う最新${FILTERED_LIST_LIMIT}件を表示`
    : 'タップで詳細を開く';
  elements.summaryHeading.textContent = '集計';
  elements.summarySubheading.textContent = hasActiveRecordFilters_()
    ? '状態と優先度を掛け合わせて確認中'
    : 'チップをタップして一覧を絞り込み';
}

function setPanelVisibility_(showSummary) {
  if (elements.summaryPanel) {
    elements.summaryPanel.hidden = !showSummary;
  }
}

function applyLoadErrorState_(error) {
  const message = error && error.message ? error.message : '表示の読み込みに失敗しました。';
  state.records = [];
  state.summary = null;
  state.histories = [];
  state.detail = null;
  state.selectedId = '';
  state.links = {};
  state.errorMessage = message;
  state.listErrorMessage = '';
  state.summaryErrorMessage = '';
  syncUrl_();
  setPanelVisibility_(state.view !== 'history');
  syncSectionHeadings_();
  renderSummary_();
  if (state.view === 'history') {
    renderHistoryView_();
  } else {
    renderList_();
  }
  syncSheetButtonState_();
  renderEmptyDetail_(message);
  clearDetailSelection_();
}

async function openSheet_() {
  const sheetUrl = state.links.sheetUrl || '';
  if (!sheetUrl) {
    throw new Error('シートURLを取得できません。');
  }

  const target = buildSheetTarget_(sheetUrl);

  if (target.type === 'intent') {
    window.location.href = target.url;
    return;
  }

  if (target.type === 'scheme') {
    window.location.href = target.url;
    window.setTimeout(function () {
      openExternalUrl_(sheetUrl);
    }, 700);
    return;
  }

  await openExternalUrl_(sheetUrl);
}

async function submitDetailForm_(form, record) {
  const formData = new FormData(form);
  const nextStatus = String(formData.get('status') || '');
  const shouldReport = String(formData.get('lineReport') || '') === 'true';

  if (!hasPersistedDetailChanges_(form, record) && !shouldReport) {
    await closeDetailAfterSave_();
    return;
  }

  const response = await requestApi_(buildDetailUpdatePayload_(formData, record));
  const savedRecord = response.data.record;
  if (shouldReport && isDoneStatus_(nextStatus)) {
    await sendCompletionReport_(savedRecord);
  }
  await closeDetailAfterSave_();
}

async function closeDetailAfterSave_() {
  clearDetailSelection_();
  renderEmptyDetail_(getDefaultDetailEmptyMessage_());
  await loadCurrentView_();
}

function buildDetailUpdatePayload_(formData, record) {
  const payload = {
    api: 'update',
    entity: record.entityType,
    id: record.id,
    title: String(formData.get('title') || '').trim(),
    detail: String(formData.get('detail') || ''),
    memo: String(formData.get('memo') || ''),
    status: String(formData.get('status') || ''),
    priority: String(formData.get('priority') || ''),
    changedBy: state.profileId || 'liff-user',
  };

  if (record.entityType === 'task') {
    payload.dueDate = String(formData.get('dueDate') || '').trim();
    payload.assignee = String(formData.get('assignee') || '').trim();
  }

  return payload;
}

function requestApi_(params) {
  const baseUrl = (window.APP_CONFIG && window.APP_CONFIG.apiBaseUrl) || '';
  if (!baseUrl) {
    return Promise.reject(new Error('APP_CONFIG.apiBaseUrl を設定してください。'));
  }

  return withLoading_(jsonpRequest_(baseUrl, Object.assign({
    _ts: Date.now(),
    userId: state.profileId || '',
    accessToken: state.accessToken || '',
  }, params), getApiTimeoutMs_(params)), buildLoadingLabel_(params));
}

function jsonpRequest_(baseUrl, params, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const callbackName = `__bugsheet_cb_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const url = new URL(baseUrl);

    Object.keys(params || {}).forEach(function (key) {
      if (params[key] === undefined || params[key] === null || params[key] === '') return;
      url.searchParams.set(key, params[key]);
    });
    url.searchParams.set('callback', callbackName);

    const script = document.createElement('script');
    const timeoutId = window.setTimeout(function () {
      cleanup_();
      reject(new Error('API 応答がタイムアウトしました。'));
    }, timeoutMs || 20000);

    window[callbackName] = function (payload) {
      cleanup_();
      if (!payload || payload.ok !== true) {
        reject(new Error(payload && payload.error ? payload.error.message : 'API エラー'));
        return;
      }
      resolve(payload);
    };

    script.onerror = function () {
      cleanup_();
      reject(new Error('API の読み込みに失敗しました。'));
    };

    script.src = url.toString();
    document.body.append(script);

    function cleanup_() {
      window.clearTimeout(timeoutId);
      delete window[callbackName];
      if (script.parentNode) {
        script.parentNode.removeChild(script);
      }
    }
  });
}

function showFatalError_(error) {
  console.error(error);
  setProfileMenuOpen_(false);
  applyLoadErrorState_(error);
}

function syncProfileUi_() {
  if (!elements.profileAnchor || !elements.profileButton || !elements.profileName) {
    return;
  }

  const visible = !!(state.profileId || state.profileName);
  elements.profileAnchor.hidden = !visible;
  if (!visible) {
    setProfileMenuOpen_(false);
    return;
  }

  elements.profileName.textContent = state.profileName || state.profileId || '-';

  if (elements.profileAvatar && elements.profileFallback) {
    if (state.profilePictureUrl) {
      elements.profileAvatar.hidden = false;
      elements.profileAvatar.src = state.profilePictureUrl;
      elements.profileFallback.hidden = true;
    } else {
      elements.profileAvatar.hidden = true;
      elements.profileAvatar.removeAttribute('src');
      elements.profileFallback.hidden = false;
    }
  }
}

function setProfileMenuOpen_(isOpen) {
  if (!elements.profileMenu || !elements.profileButton) return;

  elements.profileMenu.hidden = !isOpen;
  elements.profileButton.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
}

function toggleProfileMenu_() {
  if (!elements.profileMenu) return;
  setProfileMenuOpen_(elements.profileMenu.hidden);
}

async function logoutFromLiff_() {
  setProfileMenuOpen_(false);

  if (window.liff && typeof window.liff.logout === 'function') {
    window.liff.logout();
  }

  window.location.reload();
}

function getSummaryRenderErrorMessage_() {
  return state.errorMessage || state.summaryErrorMessage || '';
}

function getListRenderErrorMessage_() {
  return state.errorMessage || state.listErrorMessage || '';
}

function getErrorMessage_(error, fallback) {
  return error && error.message ? error.message : fallback;
}

function buildSheetTarget_(sheetUrl) {
  const sheetId = extractSpreadsheetId_(sheetUrl);
  const userAgent = navigator.userAgent || '';

  if (!sheetId) {
    return { type: 'web', url: sheetUrl };
  }

  if (/Android/i.test(userAgent)) {
    return {
      type: 'intent',
      url: `intent://docs.google.com/spreadsheets/d/${sheetId}/edit#Intent;scheme=https;package=com.google.android.apps.docs.editors.sheets;end`,
    };
  }

  if (/iPhone|iPad|iPod/i.test(userAgent)) {
    return {
      type: 'scheme',
      url: `googlesheets://docs.google.com/spreadsheets/d/${sheetId}/edit`,
    };
  }

  return { type: 'web', url: sheetUrl };
}

function extractSpreadsheetId_(sheetUrl) {
  const match = String(sheetUrl || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : '';
}

async function openExternalUrl_(url) {
  if (window.liff && typeof window.liff.openWindow === 'function') {
    window.liff.openWindow({ url: url, external: true });
    return;
  }

  window.open(url, '_blank', 'noopener');
}

function syncSheetButtonState_() {
  if (!elements.sheetButton) return;

  const active = !!state.links.sheetUrl;
  elements.sheetButton.disabled = !active;
  elements.sheetButton.style.opacity = active ? '1' : '0.45';
}

function getDefaultDetailEmptyMessage_() {
  return state.records.length ? DETAIL_EMPTY_MESSAGE : DETAIL_EMPTY_NO_RECORDS_MESSAGE;
}

function showDetailEmptyState_() {
  renderEmptyDetail_(getDefaultDetailEmptyMessage_());
  setDetailOpen_(false);
}

function withLoading_(promise, label) {
  setLoading_(true, label);
  return promise.finally(function () {
    setLoading_(false);
  });
}

function setLoading_(isLoading, label) {
  state.loadingCount = Math.max(0, state.loadingCount + (isLoading ? 1 : -1));

  if (label && elements.loadingLabel) {
    elements.loadingLabel.textContent = label;
  }

  if (!elements.loadingOverlay) return;

  const active = state.loadingCount > 0;
  elements.loadingOverlay.classList.toggle('is-open', active);
  elements.loadingOverlay.setAttribute('aria-hidden', active ? 'false' : 'true');

  if (!active && elements.loadingLabel) {
    elements.loadingLabel.textContent = '読み込み中...';
  }
}

function buildLoadingLabel_(params) {
  const api = String((params && params.api) || '');

  switch (api) {
    case 'list':
      return '一覧を読み込み中...';
    case 'summary':
      return '集計を読み込み中...';
    case 'detail':
      return '詳細を読み込み中...';
    case 'status':
      return '状態を更新中...';
    case 'update':
      return '保存中...';
    default:
      return '読み込み中...';
  }
}

function getApiTimeoutMs_(params) {
  const api = String((params && params.api) || '');

  switch (api) {
    case 'summary':
      return 30000;
    default:
      return 20000;
  }
}

async function sendCompletionReport_(record) {
  const text = `完了報告\n${record.id} ${record.status}`;

  if (window.liff && typeof window.liff.sendMessages === 'function' && window.liff.isInClient && window.liff.isInClient()) {
    await window.liff.sendMessages([{ type: 'text', text: text }]);
  }
}

function splitDecoratedLabel_(label) {
  const value = String(label || '').trim();
  const match = value.match(/^(\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\u2600-\u27BF\uFE0F])+/u);

  if (!match) {
    return { icon: '', label: value };
  }

  return {
    icon: match[0],
    label: value.slice(match[0].length).replace(/^[_\s]+/, '') || value,
  };
}

function splitDecoratedText_(text) {
  const value = String(text || '').trim();
  const match = value.match(/^(\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\u2600-\u27BF\uFE0F])+/u);

  if (!match) {
    return { icon: '', label: value };
  }

  return {
    icon: match[0],
    label: value.slice(match[0].length) || value,
  };
}

function stripPriorityLabel_(label) {
  const upper = String(label || '').toUpperCase();
  if (upper.indexOf('LOW') >= 0) return 'LOW';
  if (upper.indexOf('MEDIUM') >= 0) return 'MEDIUM';
  if (upper.indexOf('HIGH') >= 0) return 'HIGH';
  return upper;
}

function isRecordMatchedByFilter_(record, sortType, sortValue) {
  if (!sortValue) {
    return true;
  }

  if (sortType === 'status') {
    return String(record.status || '') === String(sortValue || '');
  }

  if (sortType === 'priority') {
    return String(record.priority || '') === String(sortValue || '');
  }

  return false;
}

function isActiveSort_(sortType, sortValue) {
  if (sortType === 'status') {
    return state.statusFilter === sortValue;
  }

  if (sortType === 'priority') {
    return state.priorityFilter === sortValue;
  }

  return false;
}

function buildListRequestParams_() {
  return {
    api: 'list',
    entity: state.entity,
    includeDone: hasActiveRecordFilters_(),
    limit: hasActiveRecordFilters_() ? FILTERED_LIST_LIMIT : DEFAULT_LIST_LIMIT,
  };
}

function hasActiveRecordFilters_() {
  return !!(state.statusFilter || state.priorityFilter);
}

function isDoneStatus_(status) {
  return String(status || '').indexOf('DONE') >= 0;
}

function getDoneStatusValue_(entityType) {
  return (STATUS_OPTIONS[entityType] || STATUS_OPTIONS.bug).find(isDoneStatus_) || '✅DONE';
}

function normalizeRecordIdDisplay_(value) {
  return String(value || '').trim();
}

function getDetailDraftFromForm_(form) {
  const formData = new FormData(form);
  return {
    title: String(formData.get('title') || ''),
    detail: String(formData.get('detail') || ''),
    memo: String(formData.get('memo') || ''),
    status: String(formData.get('status') || ''),
    priority: String(formData.get('priority') || ''),
    dueDate: String(formData.get('dueDate') || ''),
    assignee: String(formData.get('assignee') || ''),
    lineReport: String(formData.get('lineReport') || 'false'),
  };
}

function hasDirtyDetailForm_() {
  const form = elements.detailMount ? elements.detailMount.querySelector('form') : null;
  return hasPersistedDetailChanges_(form, state.detail);
}

function hasPersistedDetailChanges_(form, record) {
  if (!form || !record) return false;

  return JSON.stringify(buildComparableDraftFromForm_(form, record.entityType)) !==
    JSON.stringify(buildComparableDraftFromRecord_(record));
}

function confirmDetailDiscardIfNeeded_(nextId) {
  if (!hasDirtyDetailForm_()) return true;
  if (nextId && nextId === state.selectedId) return true;
  return window.confirm('保存していない変更があります。破棄して閉じますか？');
}

function buildComparableDraftFromForm_(form, entityType) {
  const draft = getDetailDraftFromForm_(form);

  return {
    title: String(draft.title || '').trim(),
    detail: String(draft.detail || ''),
    memo: String(draft.memo || ''),
    status: String(draft.status || ''),
    priority: String(draft.priority || ''),
    dueDate: entityType === 'task' ? String(draft.dueDate || '').trim() : '',
    assignee: entityType === 'task' ? String(draft.assignee || '').trim() : '',
  };
}

function buildComparableDraftFromRecord_(record) {
  return {
    title: String(record && record.title || '').trim(),
    detail: String(record && record.detail || ''),
    memo: String(record && record.memo || ''),
    status: String(record && record.status || ''),
    priority: String(record && record.priority || ''),
    dueDate: record && record.entityType === 'task' ? String(record.dueDate || '').trim() : '',
    assignee: record && record.entityType === 'task' ? String(record.assignee || '').trim() : '',
  };
}

function requestDetailClose_() {
  if (!confirmDetailDiscardIfNeeded_()) return;
  clearDetailSelection_();
  renderList_();
  renderEmptyDetail_(getDefaultDetailEmptyMessage_());
}

function toOption_(value) {
  return { value: value, label: value };
}
