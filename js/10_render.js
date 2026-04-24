/**
 * ============================================================================
 * Frontend Render
 * ----------------------------------------------------------------------------
 * 役割:
 * - summary / list / detail / history の描画を受け持つ
 * - DOM 組み立て helper をまとめる
 * ============================================================================
 */

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
        toggleSort_('status', entry[0]).catch(showFatalError_);
      },
    });
  }), { interactive: true });

  const priorityCard = createMetricSectionCard_('優先度', orderPriorityEntries_(state.summary.prioritySummary).map(entry => {
    return createMetricChip_(entry[0], entry[1], {
      sortType: 'priority',
      onClick: function () {
        toggleSort_('priority', entry[0]).catch(showFatalError_);
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
    empty.textContent = hasActiveRecordFilters_()
      ? `条件に合う最新${FILTERED_LIST_LIMIT}件にデータはありません。`
      : '最新の未完了データはありません。';
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
  meta.className = 'meta-list meta-list-muted detail-meta-list';
  meta.append(
    createMetaRow_('作成', record.createdAt),
    createMetaRow_('更新', record.updatedAt)
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

function appendRecordMetaParts_(mount, record) {
  [
    { text: normalizeRecordIdDisplay_(record.id), plainText: true },
    { text: record.status },
    { text: record.priority },
  ].filter(function (part) {
    return !!String(part.text || '').trim();
  }).forEach(function (part, index) {
    if (index > 0) {
      mount.append(createMetaSeparator_());
    }

    if (part.plainText) {
      mount.append(document.createTextNode(part.text));
      return;
    }

    mount.append(createDecoratedTextNode_(part.text));
  });
}

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
    const isActive = option.reportOnSelect ? false : option.value === record.status;
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
