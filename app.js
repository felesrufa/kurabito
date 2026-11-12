/* kurabito — 備蓄と日用品の在庫番
 * データは端末の中(localStorage)だけに保存し、外部には送信しない。
 * データの形は docs/DATA.md を参照。
 */
(() => {
  'use strict';

  const VERSION = '0.2.0';
  const KEY = 'kurabito:v1';
  const DRAFT_KEY = 'kurabito:draft';
  const SCHEMA = 1;
  const GENRES = { food: '食品', bousai: '防災グッズ', daily: '日用品', other: 'その他' };
  const FIELD_LABEL = { bestBefore: '賞味期限', useBy: '使用期限' };
  const BACKUP_EVERY_DAYS = 60;

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
      else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of [].concat(children)) if (c) node.append(c);
    return node;
  };

  /* ---------- 日付 ---------- */
  const pad = (n) => String(n).padStart(2, '0');
  const toDateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayStr = () => toDateStr(new Date());
  const isDateStr = (s) => {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  };
  const utc = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  /** from から to までの日数(to が未来なら正) */
  const dayDiff = (from, to) => Math.round((utc(to) - utc(from)) / 86400000);
  const addDays = (s, n) => {
    const [y, m, d] = s.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  };
  const fmtDate = (s) => { const [y, m, d] = s.split('-').map(Number); return `${y}/${m}/${d}`; };

  /* ---------- データ ---------- */
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const num = (v) => {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const newId = (prefix) => {
    const a = new Uint32Array(2);
    crypto.getRandomValues(a);
    return `${prefix}_${a[0].toString(36)}${a[1].toString(36)}`.slice(0, 14);
  };

  function sanitizeItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = str(raw.name, 80);
    if (!name) return null;
    const now = new Date().toISOString();
    const lead = num(raw.leadDays);
    // 1つあたりの量は、数と単位がそろっているときだけ使う
    const per = num(raw.amountPer);
    const perUnit = str(raw.amountUnit, 10);
    const hasAmount = per !== null && per > 0 && perUnit !== '';
    return {
      id: /^i_[a-z0-9]{4,14}$/.test(raw.id) ? raw.id : newId('i'),
      name,
      genre: Object.hasOwn(GENRES, raw.genre) ? raw.genre : 'other',
      quantity: num(raw.quantity) ?? 0,
      unit: str(raw.unit, 10),
      group: str(raw.group, 40),
      amountPer: hasAmount ? per : null,
      amountUnit: hasAmount ? perUnit : '',
      minQuantity: num(raw.minQuantity),
      bestBefore: isDateStr(raw.bestBefore) ? raw.bestBefore : null,
      useBy: isDateStr(raw.useBy) ? raw.useBy : null,
      reviewAt: isDateStr(raw.reviewAt) ? raw.reviewAt : null,
      leadDays: lead === null ? null : Math.min(365, Math.round(lead)),
      location: str(raw.location, 40),
      maker: str(raw.maker, 40),
      model: str(raw.model, 40),
      size: str(raw.size, 20),
      memo: str(raw.memo, 500),
      tags: Array.isArray(raw.tags) ? raw.tags.map((t) => str(t, 30)).filter(Boolean).slice(0, 20) : [],
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt.slice(0, 40) : now,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt.slice(0, 40) : now,
    };
  }

  function normalize(data) {
    const d = data && typeof data === 'object' ? data : {};
    const s = d.settings && typeof d.settings === 'object' ? d.settings : {};
    const lead = num(s.leadDays);
    const plan = num(s.planDays);
    const seen = new Set();
    const items = (Array.isArray(d.items) ? d.items : [])
      .map(sanitizeItem)
      .filter((it) => it && !seen.has(it.id) && seen.add(it.id));
    const alerts = {};
    if (d.alerts && typeof d.alerts === 'object') {
      for (const [k, v] of Object.entries(d.alerts)) {
        if (typeof k !== 'string' || k.length > 80 || !v || typeof v !== 'object') continue;
        const a = {};
        if (isDateStr(v.snoozeUntil)) a.snoozeUntil = v.snoozeUntil;
        if (isDateStr(v.doneAt)) a.doneAt = v.doneAt;
        if (a.snoozeUntil || a.doneAt) alerts[k] = a;
      }
    }
    // v2 以降で使う場所。第1版では中身に触らず、そのまま持ち回る。
    const keep = (v) => (Array.isArray(v) ? v : []);
    return {
      app: 'kurabito',
      schemaVersion: SCHEMA,
      settings: {
        leadDays: lead === null ? 30 : Math.min(365, Math.round(lead)),
        planDays: plan === null ? 7 : Math.min(60, Math.max(1, Math.round(plan))),
        lastExportAt: isDateStr(s.lastExportAt) ? s.lastExportAt : null,
      },
      items,
      alerts,
      people: keep(d.people),
      requirements: keep(d.requirements),
      tips: keep(d.tips),
      scores: keep(d.scores),
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      return normalize(raw ? JSON.parse(raw) : null);
    } catch {
      return normalize(null);
    }
  }

  let state = load();

  function pruneAlerts() {
    const byId = new Map(state.items.map((it) => [it.id, it]));
    for (const key of Object.keys(state.alerts)) {
      const [id, field, value] = key.split('|');
      if (id === 'backup') {
        if ((state.settings.lastExportAt || 'never') !== field) delete state.alerts[key];
        continue;
      }
      const it = byId.get(id);
      if (!it) { delete state.alerts[key]; continue; }
      if (field !== 'low' && it[field] !== value) delete state.alerts[key];
    }
  }

  function save() {
    pruneAlerts();
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch {
      toast('保存できませんでした。端末の空き容量を確認してください。');
      return false;
    }
  }

  /* ---------- 対応待ち ---------- */
  function computeAlerts() {
    const today = todayStr();
    const all = [];
    for (const it of state.items) {
      const lead = it.leadDays ?? state.settings.leadDays;
      for (const field of ['bestBefore', 'useBy']) {
        if (!it[field]) continue;
        const left = dayDiff(today, it[field]);
        if (left <= lead) all.push({ key: `${it.id}|${field}|${it[field]}`, type: 'expiry', field, item: it, left });
      }
      if (it.minQuantity !== null && it.quantity < it.minQuantity) {
        all.push({ key: `${it.id}|low|`, type: 'low', item: it, left: 1e6 });
      }
      if (it.reviewAt && dayDiff(today, it.reviewAt) <= 0) {
        all.push({ key: `${it.id}|reviewAt|${it.reviewAt}`, type: 'review', item: it, left: 1e6 + 1 });
      }
    }
    if (state.items.length > 0) {
      const last = state.settings.lastExportAt;
      if (!last || dayDiff(last, today) >= BACKUP_EVERY_DAYS) {
        all.push({ key: `backup|${last || 'never'}|`, type: 'backup', left: 1e6 + 2 });
      }
    }
    let snoozed = 0;
    const open = all.filter((a) => {
      const st = state.alerts[a.key];
      if (st?.doneAt) return false;
      if (st?.snoozeUntil && st.snoozeUntil > today) { snoozed += 1; return false; }
      return true;
    });
    open.sort((a, b) => a.left - b.left || (a.item?.name || '').localeCompare(b.item?.name || '', 'ja'));
    return { open, snoozed };
  }

  const qtyText = (it) => `${it.quantity}${it.unit || ''}`;

  function describe(a) {
    if (a.type === 'backup') {
      const last = state.settings.lastExportAt;
      return {
        cls: 'review',
        title: 'バックアップ',
        what: last ? `最後の書き出しから ${dayDiff(last, todayStr())}日 たちました` : 'まだ一度も書き出していません',
        sub: 'データはこの端末の中にしかありません。',
      };
    }
    const it = a.item;
    const where = it.location ? ` ・ ${it.location}` : '';
    if (a.type === 'expiry') {
      const label = FIELD_LABEL[a.field];
      const what = a.left < 0 ? `${label}を ${-a.left}日 過ぎています`
        : a.left === 0 ? `今日が${label}です`
        : `${label}まであと ${a.left}日`;
      return { cls: a.left < 0 ? 'over' : 'soon', title: it.name, what, sub: `${fmtDate(it[a.field])} ・ ${qtyText(it)}${where}` };
    }
    if (a.type === 'low') {
      return { cls: 'low', title: it.name, what: `残り ${qtyText(it)}(最低 ${it.minQuantity}${it.unit || ''})`, sub: `買い足しの目安を下回っています${where}` };
    }
    return { cls: 'review', title: it.name, what: '見直し日です', sub: `${fmtDate(it.reviewAt)}${it.size ? ` ・ サイズ ${it.size}` : ''} ・ ${qtyText(it)}${where}` };
  }

  function setAlert(key, value, message) {
    const before = state.alerts[key];
    state.alerts[key] = value;
    save();
    renderAll();
    toast(message, {
      label: '取り消す',
      fn: () => {
        if (before) state.alerts[key] = before; else delete state.alerts[key];
        save();
        renderAll();
      },
    });
  }

  function renderTodo() {
    const { open, snoozed } = computeAlerts();
    const box = $('#todo-list');
    box.replaceChildren();
    $('#todo-summary').textContent = open.length
      ? `${open.length}件あります。ボタンで答えるまで、毎日ここに出ます。${snoozed ? `(あとで聞く: ${snoozed}件)` : ''}`
      : (snoozed ? `あとで聞くことにしたものが ${snoozed}件 あります。` : '');
    const badge = $('#badge');
    badge.hidden = open.length === 0;
    badge.textContent = String(open.length);
    if ('setAppBadge' in navigator) {
      (open.length ? navigator.setAppBadge(open.length) : navigator.clearAppBadge()).catch(() => {});
    }

    if (open.length === 0) {
      box.append(el('div', { class: 'empty' }, [
        el('strong', { text: state.items.length ? '今日の対応待ちはありません' : 'まだ何も登録されていません' }),
        el('span', { text: state.items.length ? '期限が近づいたり、数が減ったりすると、ここに出ます。' : '右下の「＋」から、最初の1つを登録してください。' }),
      ]));
      return;
    }

    const today = todayStr();
    for (const a of open) {
      const d = describe(a);
      const actions = el('div', { class: 'actions' });
      if (a.type === 'backup') {
        actions.append(el('button', { type: 'button', class: 'btn primary', text: '書き出す', on: { click: exportData } }));
      } else if (a.type === 'expiry') {
        actions.append(
          el('button', { type: 'button', class: 'btn primary', text: '入れ替えた・直す', on: { click: () => openForm(a.item) } }),
          el('button', { type: 'button', class: 'btn', text: 'このままでいい', on: { click: () => setAlert(a.key, { doneAt: today }, 'この期限については、もう聞きません') } }),
        );
      } else if (a.type === 'low') {
        actions.append(el('button', { type: 'button', class: 'btn primary', text: '数を直す', on: { click: () => openForm(a.item) } }));
      } else {
        actions.append(
          el('button', { type: 'button', class: 'btn primary', text: '確認した', on: { click: () => setAlert(a.key, { doneAt: today }, '確認済みにしました') } }),
          el('button', { type: 'button', class: 'btn', text: '次の見直し日を決める', on: { click: () => openForm(a.item) } }),
        );
      }
      const snooze = el('div', { class: 'snooze' }, [el('span', { text: 'また聞いて:' })]);
      for (const [label, n] of [['明日', 1], ['3日後', 3], ['1週間後', 7]]) {
        snooze.append(el('button', {
          type: 'button', class: 'btn small', text: label,
          on: { click: () => setAlert(a.key, { snoozeUntil: addDays(today, n) }, `${label}にまた聞きます`) },
        }));
      }
      box.append(el('article', { class: `card ${d.cls}` }, [
        el('h3', { text: d.title }),
        el('p', { class: 'what', text: d.what }),
        el('p', { class: 'sub', text: d.sub }),
        actions,
        snooze,
      ]));
    }
  }

  /* ---------- 合計(まとめ名ごと) ---------- */
  /** 比べるときの形。全角/半角の英数字・かっこ・前後の空白の違いをなくす(読みは見ない) */
  const normKey = (s) => s.normalize('NFKC').trim();
  const fmtNum = (n) => String(Math.round(n * 1000) / 1000);
  // 自動で換算する単位: [そろえる先, 倍率]
  const UNIT_CONV = {
    ml: ['L', 0.001], 'ミリリットル': ['L', 0.001], l: ['L', 1], 'リットル': ['L', 1],
    g: ['kg', 0.001], 'グラム': ['kg', 0.001], kg: ['kg', 1], 'キログラム': ['kg', 1],
  };
  /** その品の量。1つあたりの量があれば 個数×量、なければ 個数×単位 */
  function measure(it) {
    const amount = it.amountPer !== null ? it.quantity * it.amountPer : it.quantity;
    const unit = normKey(it.amountPer !== null ? it.amountUnit : it.unit);
    const conv = Object.hasOwn(UNIT_CONV, unit.toLowerCase()) ? UNIT_CONV[unit.toLowerCase()] : null;
    return conv ? { amount: amount * conv[1], unit: conv[0] } : { amount, unit };
  }

  function computeTotals() {
    const rows = new Map();
    for (const it of state.items) {
      const label = it.group || it.name;
      const m = measure(it);
      const key = `${normKey(label)}\n${m.unit}`;   // まとめ名も単位も同じものだけ足す
      let row = rows.get(key);
      if (!row) rows.set(key, row = { label: label.trim(), unit: m.unit, total: 0, count: 0, explicit: false, byLoc: new Map() });
      row.total += m.amount;
      row.count += 1;
      if (it.group || it.amountPer !== null) row.explicit = true;
      row.byLoc.set(it.location, (row.byLoc.get(it.location) || 0) + m.amount);
    }
    // 1品だけで、まとめ名も量も入れていないものは、一覧と同じ内容なので出さない
    return [...rows.values()]
      .filter((r) => r.count > 1 || r.explicit)
      .sort((a, b) => a.label.localeCompare(b.label, 'ja') || a.unit.localeCompare(b.unit, 'ja'));
  }

  function renderTotals() {
    const rows = computeTotals();
    $('#totals').hidden = rows.length === 0;
    const ul = $('#totals-list');
    ul.replaceChildren();
    for (const r of rows) {
      const locs = [...r.byLoc.entries()].sort((a, b) => b[1] - a[1]);
      const showLocs = locs.length > 1 || locs[0][0] !== '';
      const detail = locs.map(([loc, n]) => `${loc || '置き場所なし'} ${fmtNum(n)}${r.unit}`).join('・');
      ul.append(el('li', {}, [
        el('span', { class: 'g', text: r.label }),
        el('b', { text: `合計 ${fmtNum(r.total)}${r.unit}` }),
        showLocs && el('span', { class: 'locs', text: `(${detail})` }),
      ]));
    }
  }

  /* ---------- 一覧 ---------- */
  const nearestDue = (it) => [it.bestBefore, it.useBy].filter(Boolean).sort()[0] || null;

  function duePill(it) {
    const due = nearestDue(it);
    if (!due) return null;
    const left = dayDiff(todayStr(), due);
    const lead = it.leadDays ?? state.settings.leadDays;
    if (left < 0) return el('span', { class: 'pill over', text: `期限切れ ${-left}日` });
    if (left <= lead) return el('span', { class: 'pill soon', text: left === 0 ? '今日まで' : `あと${left}日` });
    return el('span', { class: 'pill ok', text: `${fmtDate(due)}まで` });
  }

  function renderList() {
    renderTotals();
    const q = $('#q').value.trim().toLowerCase();
    const genre = $('#f-genre').value;
    const sort = $('#f-sort').value;
    let rows = state.items.filter((it) => {
      if (genre && it.genre !== genre) return false;
      if (!q) return true;
      return [it.name, it.group, it.location, it.memo, it.maker, it.model, it.size].some((v) => v.toLowerCase().includes(q));
    });
    const byName = (a, b) => a.name.localeCompare(b.name, 'ja');
    const sorters = {
      due: (a, b) => (nearestDue(a) || '9999').localeCompare(nearestDue(b) || '9999') || byName(a, b),
      name: byName,
      location: (a, b) => (a.location || '￿').localeCompare(b.location || '￿', 'ja') || byName(a, b),
      updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    };
    rows = rows.sort(sorters[sort] || sorters.due);

    $('#list-summary').textContent = state.items.length
      ? `${rows.length}件${rows.length !== state.items.length ? `(全${state.items.length}件中)` : ''}`
      : '';
    const ul = $('#item-list');
    ul.replaceChildren();
    if (rows.length === 0) {
      ul.append(el('li', { class: 'empty' }, [
        el('strong', { text: state.items.length ? '当てはまる品がありません' : 'まだ何も登録されていません' }),
        el('span', { text: state.items.length ? '検索の言葉やジャンルを変えてみてください。' : '右下の「＋」から登録できます。' }),
      ]));
      return;
    }
    for (const it of rows) {
      const short = it.minQuantity !== null && it.quantity < it.minQuantity;
      const meta = el('div', { class: 'meta' }, [
        duePill(it),
        el('span', { class: 'pill genre', text: GENRES[it.genre] }),
        it.location && el('span', { class: 'where', text: it.location }),
        it.group && el('span', { class: 'where', text: `まとめ: ${it.group}` }),
        it.amountPer !== null && el('span', { class: 'where', text: `1${it.unit || 'つ'}あたり ${fmtNum(it.amountPer)}${it.amountUnit}` }),
        it.size && el('span', { class: 'where', text: `サイズ ${it.size}` }),
      ]);
      const main = el('button', { type: 'button', class: 'main', 'aria-label': `${it.name} を編集`, on: { click: () => openForm(it) } }, [
        el('div', { class: 'name', text: it.name }),
        meta,
      ]);
      const step = (n) => () => {
        it.quantity = Math.max(0, Math.round((it.quantity + n) * 1000) / 1000);
        it.updatedAt = new Date().toISOString();
        save();
        renderAll();
      };
      const qty = el('div', { class: 'qty' }, [
        el('button', { type: 'button', class: 'step', text: '−', 'aria-label': `${it.name} を1つ減らす`, on: { click: step(-1) } }),
        el('b', { class: short ? 'short' : '', text: qtyText(it) }),
        el('button', { type: 'button', class: 'step', text: '＋', 'aria-label': `${it.name} を1つ増やす`, on: { click: step(1) } }),
      ]);
      ul.append(el('li', { class: 'item' }, [main, qty]));
    }
  }

  /* ---------- 登録・編集 ---------- */
  const dlg = $('#dlg');
  const form = $('#item-form');
  let editingId = null;

  const FIELDS = ['name', 'genre', 'location', 'quantity', 'unit', 'minQuantity', 'group', 'amountPer', 'amountUnit', 'bestBefore', 'useBy', 'reviewAt', 'leadDays', 'maker', 'model', 'size', 'memo'];

  /* 入力途中の下書き。別のアプリに移っている間にアプリが閉じられても、続きから書けるようにする */
  function saveDraft() {
    if (!dlg.open) return;
    const values = {};
    for (const name of FIELDS) values[name] = form.elements[name].value;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ editingId, values, savedAt: new Date().toISOString() }));
    } catch { /* 下書きは保存できなくても先へ進む */ }
  }
  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* noop */ }
  }
  function loadDraft() {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY));
      if (!d || typeof d !== 'object' || !d.values || typeof d.values !== 'object') return null;
      const values = {};
      for (const name of FIELDS) values[name] = typeof d.values[name] === 'string' ? d.values[name].slice(0, 500) : '';
      if (!Object.hasOwn(GENRES, values.genre)) values.genre = 'other';
      if (!Object.values(values).some((v, i) => v && FIELDS[i] !== 'genre')) return null;
      return {
        item: state.items.find((it) => it.id === d.editingId) || null,
        values,
        savedAt: typeof d.savedAt === 'string' ? new Date(d.savedAt) : null,
      };
    } catch {
      return null;
    }
  }
  function offerDraft() {
    const d = loadDraft();
    if (!d) return clearDraft();
    const when = d.savedAt && !Number.isNaN(d.savedAt.getTime())
      ? ` ・ ${d.savedAt.getMonth() + 1}月${d.savedAt.getDate()}日 ${d.savedAt.getHours()}:${pad(d.savedAt.getMinutes())}`
      : '';
    $('#draft-what').textContent = `「${d.values.name || '(品名なし)'}」を${d.item ? '編集' : '追加'}している途中でした${when}`;
    $('#b-draft-resume').onclick = () => { $('#draft-dlg').close(); openForm(d.item, d.values); };
    $('#b-draft-discard').onclick = () => { $('#draft-dlg').close(); clearDraft(); };
    $('#draft-dlg').showModal();
  }

  function openForm(item, draft) {
    editingId = item ? item.id : null;
    $('#dlg-title').textContent = item ? '品を編集' : '品を追加';
    $('#b-delete').hidden = !item;
    $('#form-error').hidden = true;
    form.reset();
    const f = form.elements;
    const v = item || { genre: 'food', quantity: 1 };
    for (const name of FIELDS) f[name].value = draft ? draft[name] : (v[name] ?? '');
    form.querySelector('.more').open = Boolean(f.maker.value || f.model.value || f.size.value || f.memo.value);
    const dl = $('#dl-location');
    dl.replaceChildren(...[...new Set(state.items.map((it) => it.location).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja')).map((loc) => el('option', { value: loc })));
    // まとめ名の候補: 使ったことのあるまとめ名(全角/半角だけの違いは1つにまとめる)
    const groups = new Map();
    for (const it of state.items) if (it.group && !groups.has(normKey(it.group))) groups.set(normKey(it.group), it.group);
    $('#dl-group').replaceChildren(...[...groups.values()].sort((a, b) => a.localeCompare(b, 'ja')).map((g) => el('option', { value: g })));
    dlg.showModal();
    if (!item && !draft) f.name.focus();
  }

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = form.elements;
    const err = $('#form-error');
    const fail = (msg, field) => { err.textContent = msg; err.hidden = false; field?.focus(); };
    if (!f.name.value.trim()) return fail('品名を入れてください。', f.name);
    for (const name of ['quantity', 'minQuantity', 'leadDays', 'amountPer']) {
      if (f[name].value !== '' && num(f[name].value) === null) return fail('数は0以上の数字で入れてください。', f[name]);
    }
    const hasPer = Number(f.amountPer.value) > 0;
    if (hasPer && !f.amountUnit.value.trim()) return fail('「1つあたりの量」の単位を入れてください(L、ml、回分 など)。', f.amountUnit);
    if (!hasPer && f.amountUnit.value.trim()) return fail('「1つあたりの量」の数を入れてください。使わないときは、量の単位も空にしてください。', f.amountPer);
    const old = state.items.find((it) => it.id === editingId);
    const item = sanitizeItem({
      ...(old || {}),
      name: f.name.value, genre: f.genre.value, location: f.location.value,
      quantity: f.quantity.value === '' ? 0 : f.quantity.value, unit: f.unit.value, minQuantity: f.minQuantity.value,
      group: f.group.value, amountPer: f.amountPer.value, amountUnit: f.amountUnit.value,
      bestBefore: f.bestBefore.value, useBy: f.useBy.value, reviewAt: f.reviewAt.value, leadDays: f.leadDays.value,
      maker: f.maker.value, model: f.model.value, size: f.size.value, memo: f.memo.value,
      updatedAt: new Date().toISOString(),
    });
    if (old) state.items[state.items.indexOf(old)] = item; else state.items.push(item);
    // 数を直したら、在庫不足のスヌーズは解除する
    if (old && old.quantity !== item.quantity) delete state.alerts[`${item.id}|low|`];
    if (save()) {
      dlg.close();
      renderAll();
      toast(old ? '保存しました' : '登録しました');
      requestPersist();
    }
  });

  form.querySelector('.qty-steps').addEventListener('click', (ev) => {
    const n = Number(ev.target.dataset?.step);
    if (!n) return;
    const input = form.elements.quantity;
    input.value = String(Math.max(0, Math.round(((num(input.value) ?? 0) + n) * 1000) / 1000));
    saveDraft();
  });
  // 入力するたびに下書きを保存。保存・やめる・削除で画面を閉じたら捨てる
  form.addEventListener('input', saveDraft);
  form.addEventListener('change', saveDraft);
  dlg.addEventListener('close', clearDraft);
  $('#b-cancel').addEventListener('click', () => dlg.close());
  $('#b-delete').addEventListener('click', () => {
    const it = state.items.find((x) => x.id === editingId);
    if (!it || !confirm(`「${it.name}」を削除します。よろしいですか？`)) return;
    state.items = state.items.filter((x) => x.id !== editingId);
    save();
    dlg.close();
    renderAll();
    toast('削除しました');
  });

  /* ---------- 書き出し・読み込み ---------- */
  async function exportData() {
    const today = todayStr();
    const data = { ...state, exportedAt: new Date().toISOString() };
    const name = `kurabito-backup-${today.replaceAll('-', '')}.json`;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    let done = false;
    try {
      const file = new File([blob], name, { type: 'application/json' });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file] });
        done = true;
      }
    } catch (e) {
      if (e?.name === 'AbortError') return; // 共有をやめた
    }
    if (!done) {
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
    state.settings.lastExportAt = today;
    save();
    renderAll();
    toast('書き出しました');
  }

  function importData(file) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return toast('ファイルが大きすぎます。');
    const reader = new FileReader();
    reader.onerror = () => toast('ファイルを読めませんでした。');
    reader.onload = () => {
      let data;
      try { data = JSON.parse(String(reader.result)); } catch { return toast('kurabitoのバックアップではないようです。'); }
      if (!data || data.app !== 'kurabito' || !Array.isArray(data.items)) return toast('kurabitoのバックアップではないようです。');
      if (Number(data.schemaVersion) > SCHEMA) return toast('新しい版で作られたファイルです。アプリを更新してから読み込んでください。');
      const next = normalize(data);
      const msg = `バックアップの ${next.items.length}件 を読み込みます。\n今この端末にある ${state.items.length}件 は置き換えられます。よろしいですか？`;
      if (!confirm(msg)) return;
      state = next;
      save();
      renderAll();
      toast(`${next.items.length}件を読み込みました`);
    };
    reader.readAsText(file);
  }

  /* ---------- 設定 ---------- */
  async function requestPersist() {
    try {
      if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
    } catch { /* 対応していない環境では何もしない */ }
    renderPersist();
  }
  async function renderPersist() {
    const p = $('#persist-state');
    let persisted = false;
    try { persisted = Boolean(await navigator.storage?.persisted?.()); } catch { /* noop */ }
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    p.textContent = persisted
      ? 'この端末に保存され、自動では消えにくい状態です。'
      : standalone
        ? 'この端末に保存されています。念のため、ときどきバックアップを書き出してください。'
        : 'ブラウザで開いています。「ホーム画面に追加」して使うと、データが消えにくくなります。';
  }

  function renderSettings() {
    $('#s-lead').value = String(state.settings.leadDays);
    const last = state.settings.lastExportAt;
    $('#last-export').textContent = last ? `最後の書き出し: ${fmtDate(last)}` : 'まだ書き出していません。';
    $('#ver').textContent = VERSION;
  }

  /* ---------- 共通 ---------- */
  let toastTimer = null;
  function toast(message, action) {
    const t = $('#toast');
    t.replaceChildren(document.createTextNode(message));
    if (action) {
      t.append(' ', el('button', {
        type: 'button', class: 'btn small', text: action.label,
        on: { click: () => { t.hidden = true; action.fn(); } },
      }));
    }
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, action ? 7000 : 2800);
  }

  function renderAll() {
    const now = new Date();
    $('#today').textContent = `${now.getMonth() + 1}月${now.getDate()}日(${'日月火水木金土'[now.getDay()]})`;
    renderTodo();
    renderList();
    renderSettings();
  }

  function showView(name) {
    for (const v of ['todo', 'list', 'settings']) {
      $(`#view-${v}`).hidden = v !== name;
      $(`#tab-${v}`).setAttribute('aria-selected', String(v === name));
    }
    $('#fab').hidden = name === 'settings';
    window.scrollTo(0, 0);
  }

  function init() {
    for (const sel of [$('#f-genre'), form.elements.genre]) {
      for (const [value, label] of Object.entries(GENRES)) sel.append(el('option', { value, text: label }));
    }
    document.querySelector('.tabs').addEventListener('click', (ev) => {
      const view = ev.target.closest('button')?.dataset.view;
      if (view) showView(view);
    });
    $('#fab').addEventListener('click', () => openForm(null));
    $('#q').addEventListener('input', renderList);
    $('#f-genre').addEventListener('change', renderList);
    $('#f-sort').addEventListener('change', renderList);
    $('#s-lead').addEventListener('change', (ev) => {
      const n = num(ev.target.value);
      state.settings.leadDays = n === null ? 30 : Math.min(365, Math.round(n));
      save();
      renderAll();
    });
    $('#b-export').addEventListener('click', exportData);
    $('#b-import').addEventListener('change', (ev) => { importData(ev.target.files[0]); ev.target.value = ''; });
    $('#b-wipe').addEventListener('click', () => {
      if (!confirm('この端末のkurabitoのデータをすべて消します。元に戻せません。')) return;
      if (!confirm('本当に消しますか？ バックアップは書き出しましたか？')) return;
      localStorage.removeItem(KEY);
      clearDraft();
      state = normalize(null);
      renderAll();
      toast('すべて消しました');
    });
    // 日付が変わったら(アプリを開きっぱなしでも)出し直す
    document.addEventListener('visibilitychange', () => { if (!document.hidden) renderAll(); });

    renderAll();
    renderPersist();
    offerDraft();
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  init();
})();
