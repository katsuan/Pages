(function () {
  /**
   * 一覧/詳細で共有する表示文言
   * 読み回し時に重複しやすいので定数化しておく。
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

  /**
   * 画面状態
   * API 結果と UI 操作を同じ場所で追えるように 1 つの state に寄せる。
   */
  const state = {
    entity: getInitialEntity_(),
    view: getInitialView_(),
    selectedId: getQueryParam_('id') || '',
    filterType: '',
    filterValue: '',
    records: [],
    summary: null,
    histories: [],
    detail: null,
    links: {},
    profileId: '',
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
    loadingOverlay: document.getElementById('loadingOverlay'),
    loadingLabel: document.getElementById('loadingLabel'),
  };

  initialize_().catch(showFatalError_);

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
          filterType: '',
          filterValue: '',
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
    state.accessToken = typeof window.liff.getAccessToken === 'function'
      ? String(window.liff.getAccessToken() || '')
      : '';
    return true;
  }

  async function loadCurrentView_() {
    try {
      if (state.view === 'history') {
        await loadHistoryView_();
        return;
      }

      const results = await Promise.allSettled([
        requestApi_({ api: 'list', entity: state.entity, limit: 12 }),
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
      return;
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
   * @returns {void}
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

  /**
   * API 取得系のエラーメッセージをクリアする
   */
  function resetLoadMessages_() {
    state.errorMessage = '';
    state.listErrorMessage = '';
    state.summaryErrorMessage = '';
  }

  function renderSummary_() {
    elements.summaryMount.innerHTML = '';

    const summaryError = getSummaryRenderErrorMessage_();
    if (summaryError) {
      renderNoticeInto_(elements.summaryMount, summaryError, true);
      return;
    }

    if (!state.summary) {
      return;
    }

    const statusCard = createMetricSectionCard_('状態', objectEntries_(state.summary.statusSummary).map(entry => {
      return createMetricChip_(entry[0], entry[1], {
        sortType: 'status',
        onClick: function () {
          toggleSort_('status', entry[0]);
        },
      });
    }), { interactive: true });
    const priorityCard = createMetricSectionCard_('優先度', orderPriorityEntries_(state.summary.prioritySummary).map(entry => {
      return createMetricChip_(entry[0], entry[1], {
        sortType: 'priority',
        onClick: function () {
          toggleSort_('priority', entry[0]);
        },
      });
    }), { interactive: true });
    const countCard = createSectionCard_('件数', [
      createSummaryRow_('総数', state.summary.counts.total),
      createSummaryRow_('未完了', state.summary.counts.undone),
      createSummaryRow_('完了', state.summary.counts.done),
    ]);
    elements.summaryMount.append(statusCard, priorityCard, countCard);
  }

  function renderList_() {
    elements.listMount.innerHTML = '';

    const listError = getListRenderErrorMessage_();
    if (listError) {
      renderNoticeInto_(elements.listMount, listError, true);
      return;
    }

    const filteredRecords = getFilteredRecords_();

    if (!filteredRecords.length) {
      const empty = document.createElement('div');
      empty.className = 'record-card';
      empty.textContent = state.filterType ? '条件に合う未完了データはありません。' : '最新の未完了データはありません。';
      elements.listMount.append(empty);
      return;
    }

    filteredRecords.forEach(record => {
      elements.listMount.append(createRecordCard_(record));
    });
  }

  function renderHistoryView_() {
    setPanelVisibility_(false);
    syncSectionHeadings_();
    elements.listMount.innerHTML = '';

    if (state.errorMessage) {
      renderNoticeInto_(elements.listMount, state.errorMessage, true);
      return;
    }

    if (!state.histories.length) {
      renderNoticeInto_(elements.listMount, '最新変更はありません。', false);
      return;
    }

    state.histories.forEach(function (history) {
      elements.listMount.append(createHistoryCard_(history));
    });
  }

  /**
   * 詳細カードを描画する
   * 項目編集の責務だけを持ち、読み込みや一覧更新は他関数に任せる。
   */
  function renderDetail_() {
    if (!state.detail) {
      renderEmptyDetail_(DETAIL_EMPTY_MESSAGE);
      return;
    }

    const record = state.detail;
    const card = document.createElement('form');
    card.className = 'detail-card detail-form';
    card.addEventListener('submit', function (event) {
      event.preventDefault();
      submitDetailForm_(card, record).catch(showFatalError_);
    });

    const headline = document.createElement('div');
    headline.className = 'detail-headline';
    appendRecordMetaParts_(headline, record);

    const meta = document.createElement('div');
    meta.className = 'meta-list meta-list-muted';
    meta.append(
      createMetaRow_('更新', record.updatedAt),
      createMetaRow_('作成', record.createdAt)
    );

    card.append(
      headline,
      meta,
      createTextInputField_('件名', 'title', record.title || '', true),
      createTextareaField_('詳細', 'detail', record.detail || '', 5),
      createTextareaField_('メモ', 'memo', record.memo || '', 3),
      createStatusToggleField_(record),
      createToggleField_('優先度', 'priority', getPriorityOptions_(), record.priority)
    );

    if (record.entityType === 'task') {
      card.append(
        createTextInputField_('期限', 'dueDate', record.dueDate || '', false, 'YYYY-MM-DD'),
        createTextInputField_('担当', 'assignee', record.assignee || '', false)
      );
    }

    const actions = document.createElement('div');
    actions.className = 'detail-actions';

    const saveButton = document.createElement('button');
    saveButton.className = 'status-button status-button-primary';
    saveButton.type = 'submit';
    saveButton.textContent = `${normalizeRecordIdDisplay_(record.id)} を保存`;
    actions.append(saveButton);

    card.append(actions);
    elements.detailMount.innerHTML = '';
    elements.detailMount.append(card);
  }

  function renderEmptyDetail_(message) {
    elements.detailMount.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'detail-empty';

    const text = document.createElement('p');
    text.textContent = message;

    wrapper.append(text);
    elements.detailMount.append(wrapper);
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
   * @returns {void}
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

  function createSectionCard_(title, rows) {
    const card = document.createElement('section');
    card.className = 'summary-card';

    const heading = document.createElement('h3');
    heading.textContent = title;

    const list = document.createElement('div');
    list.className = 'summary-list';
    rows.forEach(function (row) {
      list.append(row);
    });

    card.append(heading, list);
    return card;
  }

  function createNoticeCard_(message, isError) {
    const card = document.createElement('div');
    card.className = `record-card notice-card${isError ? ' is-error' : ''}`;
    card.textContent = message;
    return card;
  }

  function createMetricSectionCard_(title, rows, options) {
    const card = createSectionCard_(title, []);
    const list = card.querySelector('.summary-list');
    list.classList.add('metrics');
    if (options && options.interactive) {
      card.classList.add('summary-card-compact');
    }
    rows.forEach(function (row) {
      list.append(row);
    });
    return card;
  }

  /**
   * mount 先へ notice card を 1 件だけ描画する
   *
   * @param {HTMLElement} mount
   * @param {string} message
   * @param {boolean} isError
   * @returns {void}
   */
  function renderNoticeInto_(mount, message, isError) {
    if (!mount) return;
    mount.append(createNoticeCard_(message, isError));
  }

  function createSummaryRow_(label, value) {
    const row = document.createElement('div');
    row.className = 'summary-row';

    const left = document.createElement('span');
    left.textContent = label;

    const right = document.createElement('strong');
    right.textContent = String(value);

    row.append(left, right);
    return row;
  }

  function createMetricChip_(label, value, options) {
    const parts = splitDecoratedLabel_(label);
    const chip = document.createElement('button');
    chip.className = 'metric-chip';
    chip.type = 'button';

    if (options && options.sortType && isActiveSort_(options.sortType, label)) {
      chip.classList.add('is-active');
    }

    if (options && typeof options.onClick === 'function') {
      chip.addEventListener('click', options.onClick);
    }

    const topLine = document.createElement('div');
    topLine.className = 'metric-topline';

    const icon = document.createElement('span');
    icon.className = 'metric-icon';
    icon.textContent = parts.icon || '•';

    const chipValue = document.createElement('div');
    chipValue.className = 'metric-value';
    chipValue.textContent = String(value);

    const chipLabel = document.createElement('div');
    chipLabel.className = 'metric-label';
    chipLabel.textContent = parts.label || label;

    topLine.append(icon, chipValue);
    chip.append(topLine, chipLabel);
    return chip;
  }

  function createMetaRow_(label, value) {
    const row = document.createElement('div');
    row.className = 'meta-row';

    const left = document.createElement('span');
    left.textContent = label;

    const right = document.createElement('strong');
    right.textContent = value;

    row.append(left, right);
    return row;
  }

  /**
   * 一覧 1 件分のカードを生成する
   *
   * @param {Object} record
   * @returns {HTMLElement}
   */
  function createRecordCard_(record) {
    const card = document.createElement('article');
    card.className = `record-card${record.id === state.selectedId ? ' is-selected' : ''}`;
    card.addEventListener('click', function () {
      openDetail_(record.id).catch(showFatalError_);
    });

    const title = document.createElement('div');
    title.className = 'record-title';
    title.textContent = record.title;

    const detail = document.createElement('div');
    detail.className = 'record-detail';
    detail.textContent = record.detail || '詳細なし';

    card.append(buildRecordMeta_(record), title, detail);
    return card;
  }

  /**
   * 履歴 1 件分のカードを生成する
   *
   * @param {Object} history
   * @returns {HTMLElement}
   */
  function createHistoryCard_(history) {
    const card = document.createElement('article');
    card.className = 'history-card';

    const title = document.createElement('strong');
    title.textContent = `${history.itemId} ${history.fieldName || ''}`.trim();

    const change = document.createElement('div');
    change.className = 'history-line';
    change.textContent = `${history.beforeValue || '∅'} → ${history.afterValue || '∅'}`;

    const meta = document.createElement('div');
    meta.className = 'meta-list meta-list-muted';
    meta.append(
      createMetaRow_('更新', history.changedAt || ''),
      createMetaRow_('実行者', history.changedBy || '')
    );

    card.append(title, change, meta);
    return card;
  }

  function buildRecordMeta_(record) {
    const meta = document.createElement('div');
    meta.className = 'record-meta';
    appendRecordMetaParts_(meta, record);

    return meta;
  }

  /**
   * 一覧/詳細で使う `ID • STATUS • PRIORITY` 表示を構築する
   * status / priority は絵文字部分だけ emoji font を優先して描画する。
   *
   * @param {HTMLElement} mount
   * @param {Object} record
   * @returns {void}
   */
  function appendRecordMetaParts_(mount, record) {
    [
      { className: '', text: normalizeRecordIdDisplay_(record.id), plainText: true },
      { className: '', text: record.status },
      { className: '', text: record.priority },
    ].filter(function (part) {
      return !!String(part.text || '').trim();
    }).forEach(function (part, index) {
      if (index > 0) {
        mount.append(createMetaSeparator_());
      }

      if (part.plainText) {
        const span = document.createElement('span');
        span.textContent = part.text;
        mount.append(span);
        return;
      }

      mount.append(createDecoratedTextNode_(part.text));
    });
  }

  /**
   * `🆕OPEN` のような装飾付き文字列を、見た目は元の文字列のまま保ちつつ
   * 絵文字部分だけ emoji font 優先で描画する。
   *
   * @param {string} text
   * @param {string=} className
   * @returns {HTMLElement}
   */
  function createDecoratedTextNode_(text, className) {
    const parts = splitDecoratedText_(text);
    const wrapper = document.createElement('span');
    wrapper.className = className ? `decorated-text ${className}` : 'decorated-text';

    if (parts.icon) {
      const icon = document.createElement('span');
      icon.className = 'decorated-text-icon';
      icon.textContent = parts.icon;
      wrapper.append(icon);
    }

    const label = document.createElement('span');
    label.className = 'decorated-text-label';
    label.textContent = parts.label;
    wrapper.append(label);
    return wrapper;
  }

  /**
   * メタ表示の区切り記号を共通化する
   *
   * @returns {HTMLElement}
   */
  function createMetaSeparator_() {
    const separator = document.createElement('span');
    separator.className = 'record-meta-separator';
    separator.textContent = '•';
    return separator;
  }

  function createTextInputField_(label, name, value, isRequired, placeholder) {
    const field = document.createElement('label');
    field.className = 'detail-field';

    const heading = document.createElement('span');
    heading.className = 'detail-field-label';
    heading.textContent = label;

    const input = document.createElement('input');
    input.className = 'detail-input';
    input.type = 'text';
    input.name = name;
    input.value = value || '';
    input.required = !!isRequired;
    input.placeholder = placeholder || '';

    field.append(heading, input);
    return field;
  }

  function createTextareaField_(label, name, value, rows) {
    const field = document.createElement('label');
    field.className = 'detail-field';

    const heading = document.createElement('span');
    heading.className = 'detail-field-label';
    heading.textContent = label;

    const textarea = document.createElement('textarea');
    textarea.className = 'detail-input detail-textarea';
    textarea.name = name;
    textarea.rows = rows || 4;
    textarea.value = value || '';

    field.append(heading, textarea);
    return field;
  }

  /**
   * 汎用トグルフィールド
   * 優先度など「単一選択 + hidden input」な項目に使う。
   */
  function createToggleField_(label, name, options, activeValue) {
    const field = document.createElement('div');
    field.className = 'detail-field';

    const heading = document.createElement('span');
    heading.className = 'detail-field-label';
    heading.textContent = label;

    const group = document.createElement('div');
    group.className = 'toggle-group';
    const hidden = document.createElement('input');
    hidden.type = 'hidden';
    hidden.name = name;
    hidden.value = activeValue || '';

    (options || []).forEach(function (option) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `toggle-chip${option.value === activeValue ? ' is-active' : ''}`;
      chip.textContent = option.label;
      chip.addEventListener('click', function () {
        Array.from(group.querySelectorAll('.toggle-chip')).forEach(function (button) {
          button.classList.remove('is-active');
        });
        chip.classList.add('is-active');
        hidden.value = option.value;
        group.dispatchEvent(new CustomEvent('togglechange', { bubbles: true }));
      });
      group.append(chip);
    });

    field.append(heading, group, hidden);
    return field;
  }

  /**
   * 状態専用トグル
   * `DONE(LINE通知)` を状態選択として扱うため、汎用版とは分ける。
   */
  function createStatusToggleField_(record) {
    const options = getStatusOptions_(record.entityType).concat([{
      value: getDoneStatusValue_(record.entityType),
      label: `${getDoneStatusValue_(record.entityType)}${STATUS_NOTIFY_SUFFIX}`,
      reportOnSelect: true,
    }]);
    const field = document.createElement('div');
    field.className = 'detail-field';

    const heading = document.createElement('span');
    heading.className = 'detail-field-label';
    heading.textContent = '状態';

    const group = document.createElement('div');
    group.className = 'toggle-group';

    const statusHidden = document.createElement('input');
    statusHidden.type = 'hidden';
    statusHidden.name = 'status';
    statusHidden.value = record.status || '';

    const reportHidden = document.createElement('input');
    reportHidden.type = 'hidden';
    reportHidden.name = 'lineReport';
    reportHidden.value = 'false';

    options.forEach(function (option) {
      const isActive = option.reportOnSelect
        ? false
        : option.value === record.status;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `toggle-chip${isActive ? ' is-active' : ''}`;
      chip.textContent = option.label;
      chip.addEventListener('click', function () {
        Array.from(group.querySelectorAll('.toggle-chip')).forEach(function (button) {
          button.classList.remove('is-active');
        });
        chip.classList.add('is-active');
        statusHidden.value = option.value;
        reportHidden.value = option.reportOnSelect ? 'true' : 'false';
        group.dispatchEvent(new CustomEvent('togglechange', { bubbles: true }));
      });
      group.append(chip);
    });

    field.append(heading, group, statusHidden, reportHidden);
    return field;
  }

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

    if (!state.filterType || !state.filterValue) {
      return records;
    }

    return records.filter(function (record) {
      return isRecordMatchedByFilter_(record, state.filterType, state.filterValue);
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

  function toggleSort_(sortType, sortValue) {
    const isSame = state.filterType === sortType && state.filterValue === sortValue;

    updateNavigationState_({
      view: 'dashboard',
      filterType: isSame ? '' : sortType,
      filterValue: isSame ? '' : sortValue,
    });
    renderSummary_();
    renderList_();
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
    elements.listSubheading.textContent = 'タップで詳細を開く';
    elements.summaryHeading.textContent = '集計';
    elements.summarySubheading.textContent = 'チップをタップして一覧を絞り込み';
  }

  function setPanelVisibility_(showSummary) {
    if (elements.summaryPanel) {
      elements.summaryPanel.hidden = !showSummary;
    }
  }

  /**
   * 画面全体が継続不能な読み込み失敗時の共通ハンドラ
   *
   * @param {Error|*} error
   * @returns {void}
   */
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

  /**
   * シート起動は端末ごとの best-effort に寄せる
   */
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

  /**
   * 詳細フォームの保存処理
   * フォーム値収集、API 更新、保存後の再描画を担当する。
   */
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

  /**
   * 詳細保存後の共通 close 処理
   * 一覧再取得前に選択状態を外して、PC/スマホとも一覧へ戻す。
   */
  async function closeDetailAfterSave_() {
    clearDetailSelection_();
    renderEmptyDetail_(getDefaultDetailEmptyMessage_());
    await loadCurrentView_();
  }

  /**
   * 詳細フォームから API 更新 payload を組み立てる
   *
   * @param {FormData} formData
   * @param {Object} record
   * @returns {Object}
   */
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

  /**
   * JSONP リクエスト
   * GitHub Pages / LIFF から GAS WebApp を叩くための最小実装。
   */
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
    applyLoadErrorState_(error);
  }

  /**
   * `summary` パネル側に表示すべきエラー文言を返す
   */
  function getSummaryRenderErrorMessage_() {
    return state.errorMessage || state.summaryErrorMessage || '';
  }

  /**
   * `list` パネル側に表示すべきエラー文言を返す
   */
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

  /**
   * 詳細が空の時の文言を、現在の一覧状態に応じて返す
   */
  function getDefaultDetailEmptyMessage_() {
    return state.records.length ? DETAIL_EMPTY_MESSAGE : DETAIL_EMPTY_NO_RECORDS_MESSAGE;
  }

  /**
   * 詳細空状態へ戻す
   * PC/スマホの close 動線から共通で使う。
   */
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

  /**
   * API ごとの待ち時間
   * 集計は Spreadsheet 読み込みと集約で遅くなりやすいため、少し長めにする。
   *
   * @param {Object} params
   * @returns {number}
   */
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

  /**
   * 装飾テキスト表示用の分割
   * 絵文字以降の文字は加工せず、入力内容をそのまま残す。
   *
   * @param {string} text
   * @returns {{icon: string, label: string}}
   */
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
    if (sortType === 'status') {
      return String(record.status || '') === String(sortValue || '');
    }

    if (sortType === 'priority') {
      return String(record.priority || '') === String(sortValue || '');
    }

    return false;
  }

  function isActiveSort_(sortType, sortValue) {
    return state.filterType === sortType && state.filterValue === sortValue;
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

  /**
   * 実際に保存対象となる値に差分があるかを判定する
   * `LINE通知` は永続化しないため dirty 判定からは除外する。
   *
   * @param {HTMLFormElement|null} form
   * @param {Object|null} record
   * @returns {boolean}
   */
  function hasPersistedDetailChanges_(form, record) {
    if (!form || !record) return false;

    return JSON.stringify(buildComparableDraftFromForm_(form, record.entityType)) !==
      JSON.stringify(buildComparableDraftFromRecord_(record));
  }

  /**
   * 画面遷移前の未保存確認
   *
   * @param {string=} nextId 次に開こうとしている record id
   * @returns {boolean}
   */
  function confirmDetailDiscardIfNeeded_(nextId) {
    if (!hasDirtyDetailForm_()) return true;
    if (nextId && nextId === state.selectedId) return true;
    return window.confirm('保存していない変更があります。破棄して閉じますか？');
  }

  /**
   * フォーム現在値を「保存対象だけ」に絞った比較用データへ変換する
   *
   * @param {HTMLFormElement} form
   * @param {string} entityType
   * @returns {Object}
   */
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

  /**
   * record を比較用の保存対象データへ正規化する
   *
   * @param {Object} record
   * @returns {Object}
   */
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

  /**
   * 詳細 close ボタン/overlay 用の閉じる処理
   */
  function requestDetailClose_() {
    if (!confirmDetailDiscardIfNeeded_()) return;
    clearDetailSelection_();
    renderList_();
    renderEmptyDetail_(getDefaultDetailEmptyMessage_());
  }

  function toOption_(value) {
    return { value: value, label: value };
  }
})();
