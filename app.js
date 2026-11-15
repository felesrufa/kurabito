/* kurabito — 備蓄と日用品の在庫番
 * データは端末の中(localStorage)だけに保存し、外部には送信しない。
 * データの形は docs/DATA.md を参照。
 */
(() => {
  'use strict';

  const VERSION = '0.4.1';
  const KEY = 'kurabito:v1';
  const DRAFT_KEY = 'kurabito:draft';
  const COPY_DRAFT_KEY = 'kurabito:draft-copy';   // 「この品をコピー」の下書き。コピー元の下書きとは別に持つ
  const YOMI_MAX = 100;
  const SCHEMA = 1;
  // 最初の4つのジャンル。識別子は変えない・消せない(名前は変えられる)。「その他」は行き先の受け皿
  const BUILTIN_GENRES = [['food', '食品'], ['bousai', '防災グッズ'], ['daily', '日用品'], ['other', 'その他']];
  const isBuiltinGenre = (id) => BUILTIN_GENRES.some(([b]) => b === id);
  const GENRE_NAME_MAX = 20;
  const GENRE_MAX = 50;
  // 買い物の印。'' = なし。在庫の数え方には関わらない(数量だけで数える)
  const MARKS = { buy: '買いたい', avoid: 'もう買わない' };
  const REASON_MAX = 10000;   // 読み込み時だけ切る。画面では制限しない
  const LOC_NONE = ' ';       // 置き場所の絞り込みで「置き場所なし」を表す値(置き場所は前後の空白を取るので重ならない)
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

  /** 比べるときの形。全角/半角の英数字・かっこ・前後の空白の違いをなくす(読みは見ない) */
  const normKey = (s) => s.normalize('NFKC').trim();
  /** NFKC にそろえ、カタカナをひらがなに直す(長音「ー」はそのまま) */
  const toHira = (s) => s.normalize('NFKC').replace(/[\u30A1-\u30F6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  /** 並び順の鍵。よみがながあればよみがな、なければ品名。かなはひらがなにそろえて比べる */
  const sortKey = (it) => toHira(it.yomi || it.name);
  const byName = (a, b) => sortKey(a).localeCompare(sortKey(b), 'ja') || a.name.localeCompare(b.name, 'ja');

  /** ジャンルの一覧を整える。一覧がない古いデータは最初の4つだけにする */
  function sanitizeGenres(raw) {
    const out = [];
    const ids = new Set();
    const names = new Set();
    const add = (id, name) => {
      // 同じ名前が紛れていたら、後ろに番号を付けて区別する(品のひも付けを切らないため)
      let label = name;
      for (let n = 2; names.has(normKey(label)); n += 1) label = `${name.slice(0, GENRE_NAME_MAX - 3)}(${n})`;
      ids.add(id);
      names.add(normKey(label));
      out.push({ id, name: label });
    };
    for (const g of Array.isArray(raw) ? raw : []) {
      if (!g || typeof g !== 'object' || typeof g.id !== 'string' || ids.has(g.id)) continue;
      if (!isBuiltinGenre(g.id) && (!/^g_[a-z0-9]{4,14}$/.test(g.id) || out.length >= GENRE_MAX)) continue;
      const name = str(g.name, GENRE_NAME_MAX);
      if (name) add(g.id, name);
    }
    for (const [id, name] of BUILTIN_GENRES) if (!ids.has(id)) add(id, name);
    return out;
  }

  function sanitizeItem(raw, genreIds) {
    if (!raw || typeof raw !== 'object') return null;
    const name = str(raw.name, 80);
    if (!name) return null;
    const now = new Date().toISOString();
    const lead = num(raw.leadDays);
    // 1つあたりの量は、数と単位がそろっているときだけ使う
    const per = num(raw.amountPer);
    const perUnit = str(raw.amountUnit, 10);
    const hasAmount = per !== null && per > 0 && perUnit !== '';
    const mark = Object.hasOwn(MARKS, raw.mark) ? raw.mark : '';
    return {
      id: /^i_[a-z0-9]{4,14}$/.test(raw.id) ? raw.id : newId('i'),
      name,
      yomi: typeof raw.yomi === 'string' ? toHira(raw.yomi).trim().slice(0, YOMI_MAX) : '',   // ひらがなにそろえて持つ
      genre: genreIds.has(raw.genre) ? raw.genre : 'other',
      quantity: num(raw.quantity) ?? 0,
      unit: str(raw.unit, 10),
      group: str(raw.group, 40),
      amountPer: hasAmount ? per : null,
      amountUnit: hasAmount ? perUnit : '',
      minQuantity: num(raw.minQuantity),
      mark,
      avoidReason: mark === 'avoid' ? str(raw.avoidReason, REASON_MAX) : '',   // 空でも読み込みは弾かない
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
    const genres = sanitizeGenres(d.genres);
    const genreIds = new Set(genres.map((g) => g.id));
    const items = (Array.isArray(d.items) ? d.items : [])
      .map((it) => sanitizeItem(it, genreIds))
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
      genres,
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

  const genreIds = () => new Set(state.genres.map((g) => g.id));
  const genreName = (id) => (state.genres.find((g) => g.id === id) || state.genres.find((g) => g.id === 'other')).name;

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
  /** 買い足しの目安を下回っているか。すでに「買いたい」「もう買わない」の品には出さない */
  const isShort = (it) => it.mark === '' && it.minQuantity !== null && it.quantity < it.minQuantity;

  function computeAlerts() {
    const today = todayStr();
    const all = [];
    for (const it of state.items) {
      const lead = it.leadDays ?? state.settings.leadDays;
      for (const field of ['bestBefore', 'useBy']) {
        if (!it[field] || it.quantity === 0) continue;   // 手元にない品の期限は知らせない
        const left = dayDiff(today, it[field]);
        if (left <= lead) all.push({ key: `${it.id}|${field}|${it[field]}`, type: 'expiry', field, item: it, left });
      }
      if (isShort(it)) {
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

  /** その品が入る合計の行。まとめ名も単位も同じものだけ足す */
  const totalKey = (it) => `${normKey(it.group || it.name)}\n${measure(it).unit}`;

  function computeTotals(items) {
    const rows = new Map();
    for (const it of items) {
      if (it.quantity === 0) continue;   // 足しても変わらないので、行を作らない
      const label = it.group || it.name;
      const m = measure(it);
      const key = totalKey(it);
      let row = rows.get(key);
      if (!row) rows.set(key, row = { key, label: label.trim(), unit: m.unit, total: 0, count: 0, explicit: false, byLoc: new Map() });
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

  // 合計の行をタップして選んだまとめ({ key, label, unit })。null = 絞り込みなし
  let groupFilter = null;

  function renderTotals(items, filtering) {
    const rows = computeTotals(items);
    $('#totals').hidden = rows.length === 0 && !filtering;
    $('#totals-title').textContent = filtering ? '絞り込み中の合計' : 'まとめ名ごとの合計';
    const ul = $('#totals-list');
    ul.replaceChildren();
    if (rows.length === 0) ul.append(el('li', { class: 'none', text: '合計する品がありません。' }));
    for (const r of rows) {
      const locs = [...r.byLoc.entries()].sort((a, b) => b[1] - a[1]);
      const showLocs = locs.length > 1 || locs[0][0] !== '';
      const detail = locs.map(([loc, n]) => `${loc || '置き場所なし'} ${fmtNum(n)}${r.unit}`).join('・');
      const on = groupFilter?.key === r.key;
      ul.append(el('li', {}, [el('button', {
        type: 'button', 'aria-pressed': String(on),
        'aria-label': on ? `${r.label} の絞り込みを解除` : `${r.label} だけに絞り込む`,
        on: { click: () => { groupFilter = on ? null : { key: r.key, label: r.label, unit: r.unit }; renderList(); } },
      }, [
        el('span', { class: 'g', text: r.label }),
        el('b', { text: `合計 ${fmtNum(r.total)}${r.unit}` }),
        showLocs && el('span', { class: 'locs', text: `(${detail})` }),
      ])]));
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

  /** 置き場所の選択欄を、登録済みの品の置き場所から作り直す(表記ゆれは吸収しない) */
  function renderLocationOptions() {
    const sel = $('#f-location');
    const cur = sel.value;
    const locs = [...new Set(state.items.map((it) => it.location).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'));
    sel.replaceChildren(
      el('option', { value: '', text: 'すべての置き場所' }),
      el('option', { value: LOC_NONE, text: '置き場所なし' }),
      ...locs.map((loc) => el('option', { value: loc, text: loc })),
    );
    sel.value = cur === LOC_NONE || locs.includes(cur) ? cur : '';
  }

  function renderList() {
    renderLocationOptions();
    const q = $('#q').value.trim().toLowerCase();
    const qHira = toHira(q).trim();   // よみがなと比べるときは、検索語のカタカナもひらがなに直す
    const genre = $('#f-genre').value;
    const loc = $('#f-location').value;
    const mark = $('#f-mark').value;
    const sort = $('#f-sort').value;
    const filtering = Boolean(q || genre || loc || mark || groupFilter);
    let rows = state.items.filter((it) => {
      if (genre && it.genre !== genre) return false;
      if (loc && it.location !== (loc === LOC_NONE ? '' : loc)) return false;
      if (mark && it.mark !== mark) return false;
      if (groupFilter && totalKey(it) !== groupFilter.key) return false;
      if (!q) return true;
      if (qHira && it.yomi.includes(qHira)) return true;
      return [it.name, it.group, it.location, it.memo, it.maker, it.model, it.size, it.avoidReason].some((v) => v.toLowerCase().includes(q));
    });
    // 合計は、絞り込んだ品だけで出す
    renderTotals(rows, filtering);
    const chip = $('#group-chip');
    chip.hidden = !groupFilter;
    if (groupFilter) $('#group-chip-clear').textContent = `まとめ名:${groupFilter.label}${groupFilter.unit ? `(${groupFilter.unit})` : ''} ✕`;
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
        el('span', { text: state.items.length ? '検索の言葉や絞り込みを変えてみてください。' : '右下の「＋」から登録できます。' }),
      ]));
      return;
    }
    // 同じ品名(normKey)・同じ印の品は、一行に束ねて見せる。束ねるのは描画だけで、絞り込み・並び・合計は rows のまま
    const bundles = new Map();
    for (const it of rows) {
      const key = `${normKey(it.name)}\n${it.mark}`;
      if (!bundles.has(key)) bundles.set(key, []);
      bundles.get(key).push(it);
    }
    for (const members of bundles.values()) {   // Map は入れた順 = 束の先頭の品の並び順
      if (members.length === 1) {
        ul.append(el('li', { class: 'item' }, itemParts(members[0], false)));
        continue;
      }
      const byDue = members.slice().sort((a, b) => (nearestDue(a) || '9999').localeCompare(nearestDue(b) || '9999'));
      const first = byDue[0];
      const sameUnit = new Set(byDue.map((m) => normKey(m.unit))).size === 1;   // 単位が違うなら合計は出さない
      const sum = byDue.reduce((n, m) => n + m.quantity, 0);
      ul.append(el('li', { class: 'item bundle' }, [
        el('div', { class: 'bundle-head' }, [
          el('div', { class: 'name', text: first.name }),
          first.mark && el('span', { class: `pill ${first.mark}`, text: MARKS[first.mark] }),
          el('span', { class: 'count', text: `${byDue.length}件` }),
          sameUnit && el('b', { class: 'sum', text: `合計 ${fmtNum(sum)}${first.unit}` }),
        ]),
        ...byDue.map((m) => el('div', { class: 'sub' }, itemParts(m, true))),
        el('button', { type: 'button', class: 'btn small add-due', text: '＋別の期限を足す', 'aria-label': `${first.name} に別の期限を足す`, on: { click: () => openCopy(first) } }),
      ]));
    }
  }

  /** 一覧の1品分(編集ボタン・数量の＋/−・「買った」)。inBundle = 束の中の行(品名と印は束の見出しに出す) */
  function itemParts(it, inBundle) {
    const meta = el('div', { class: 'meta' }, [
      !inBundle && it.mark && el('span', { class: `pill ${it.mark}`, text: MARKS[it.mark] }),
      duePill(it) || (inBundle && el('span', { class: 'pill genre', text: '期限なし' })),
      el('span', { class: 'pill genre', text: genreName(it.genre) }),
      it.location && el('span', { class: 'where', text: it.location }),
      it.group && el('span', { class: 'where', text: `まとめ: ${it.group}` }),
      it.amountPer !== null && el('span', { class: 'where', text: `1${it.unit || 'つ'}あたり ${fmtNum(it.amountPer)}${it.amountUnit}` }),
      it.size && el('span', { class: 'where', text: `サイズ ${it.size}` }),
    ]);
    const due = nearestDue(it);
    const label = inBundle ? `${it.name}(${due ? `期限 ${fmtDate(due)}` : '期限なし'})` : it.name;
    const main = el('button', { type: 'button', class: 'main', 'aria-label': `${label} を編集`, on: { click: () => openForm(it) } }, [
      !inBundle && el('div', { class: 'name', text: it.name }),
      it.mark === 'avoid' && it.avoidReason && el('div', { class: 'reason', text: `理由: ${it.avoidReason}` }),
      meta,
    ]);
    const step = (n) => () => {
      it.quantity = Math.max(0, Math.round((it.quantity + n) * 1000) / 1000);
      it.updatedAt = new Date().toISOString();
      save();
      renderAll();
    };
    const qty = el('div', { class: 'qty' }, [
      el('button', { type: 'button', class: 'step', text: '−', 'aria-label': `${label} を1つ減らす`, on: { click: step(-1) } }),
      el('b', { class: isShort(it) ? 'short' : '', text: qtyText(it) }),
      el('button', { type: 'button', class: 'step', text: '＋', 'aria-label': `${label} を1つ増やす`, on: { click: step(1) } }),
    ]);
    const bought = it.mark === 'buy' && el('div', { class: 'row-actions' }, [
      el('button', { type: 'button', class: 'btn small primary', text: '買った', 'aria-label': `${label} を買った`, on: { click: () => openForm(it, { bought: true }) } }),
    ]);
    return [main, qty, bought];
  }

  /* ---------- 登録・編集 ---------- */
  const dlg = $('#dlg');
  const form = $('#item-form');
  let editingId = null;

  const FIELDS = ['name', 'yomi', 'genre', 'location', 'quantity', 'unit', 'minQuantity', 'group', 'amountPer', 'amountUnit', 'mark', 'avoidReason', 'bestBefore', 'useBy', 'reviewAt', 'leadDays', 'maker', 'model', 'size', 'memo'];
  // コピーで空にする欄(数量・期限・見直し日・買い物の印・理由)。ほかは引き継ぐ
  const COPY_BLANK = new Set(['quantity', 'bestBefore', 'useBy', 'reviewAt', 'mark', 'avoidReason']);
  let copyMode = false;   // コピーで開いた新規登録フォームか
  let copyTags = [];      // コピー元から引き継ぐタグ(入力欄がないので別に持つ)

  /* 入力途中の下書き。別のアプリに移っている間にアプリが閉じられても、続きから書けるようにする。
   * コピーのフォームは別の置き場所(COPY_DRAFT_KEY)に書くので、コピー元の下書きと混ざらない */
  const draftKey = () => (copyMode ? COPY_DRAFT_KEY : DRAFT_KEY);
  function saveDraft() {
    if (!dlg.open) return;
    const values = {};
    for (const name of FIELDS) values[name] = form.elements[name].value;
    const draft = { editingId: copyMode ? null : editingId, values, savedAt: new Date().toISOString() };
    if (copyMode) draft.tags = copyTags;
    try {
      localStorage.setItem(draftKey(), JSON.stringify(draft));
    } catch { /* 下書きは保存できなくても先へ進む */ }
  }
  function clearDraft(key = draftKey()) {
    try { localStorage.removeItem(key); } catch { /* noop */ }
  }
  function loadDraft(key) {
    try {
      const d = JSON.parse(localStorage.getItem(key));
      if (!d || typeof d !== 'object' || !d.values || typeof d.values !== 'object') return null;
      const values = {};
      for (const name of FIELDS) values[name] = typeof d.values[name] === 'string' ? d.values[name].slice(0, name === 'avoidReason' ? REASON_MAX : 500) : '';
      if (!Object.hasOwn(MARKS, values.mark)) values.mark = '';
      if (!genreIds().has(values.genre)) values.genre = 'other';   // 消されたジャンルは「その他」として戻す
      if (!Object.values(values).some((v, i) => v && FIELDS[i] !== 'genre')) return null;
      return {
        item: state.items.find((it) => it.id === d.editingId) || null,
        values,
        tags: Array.isArray(d.tags) ? d.tags : [],
        savedAt: typeof d.savedAt === 'string' ? new Date(d.savedAt) : null,
      };
    } catch {
      return null;
    }
  }
  /** 書きかけがあれば、続けるか聞く。コピーの下書き → ふつうの下書き の順に1つずつ */
  function offerDraft() {
    if (dlg.open || $('#draft-dlg').open) return;
    for (const key of [COPY_DRAFT_KEY, DRAFT_KEY]) {
      const d = loadDraft(key);
      if (!d) { clearDraft(key); continue; }
      const isCopy = key === COPY_DRAFT_KEY;
      const when = d.savedAt && !Number.isNaN(d.savedAt.getTime())
        ? ` ・ ${d.savedAt.getMonth() + 1}月${d.savedAt.getDate()}日 ${d.savedAt.getHours()}:${pad(d.savedAt.getMinutes())}`
        : '';
      const doing = isCopy ? 'コピーして追加' : d.item ? '編集' : '追加';
      $('#draft-what').textContent = `「${d.values.name || '(品名なし)'}」を${doing}している途中でした${when}`;
      $('#b-draft-resume').onclick = () => {
        $('#draft-dlg').close();
        if (isCopy) openForm(null, { draft: d.values, copy: true, tags: d.tags }); else openForm(d.item, { draft: d.values });
      };
      $('#b-draft-discard').onclick = () => { $('#draft-dlg').close(); clearDraft(key); offerDraft(); };
      $('#draft-dlg').showModal();
      return;
    }
  }

  function closeForm() {
    clearDraft();
    dlg.close();
  }

  /* 「もう買わない」の品に似た登録への注意(保存は止めない) */
  // 容量・本数のような表記(500ml / 2L / 24本 / 6個 / ×12 など)
  const QTY_WORDS = /[×*]?\s*\d+(?:\.\d+)?\s*(?:ml|mm|cm|kg|cc|l|g|m|本|個|枚|袋|箱|缶|食|回分|回|巻|ロール|セット|パック|組|粒|錠|包|入り|入)(?![a-z])/g;
  const QTY_TIMES = /[×*]\s*\d+(?:\.\d+)?/g;
  const QTY_X = /(^|[^a-z])x\s*\d+(?:\.\d+)?/g;   // 「x12」。英単語の途中の x は残す(古い Safari でも動くよう、後読みは使わない)
  /** 品名から、容量・本数の表記と、空白・記号を取り除いた名前 */
  const coreName = (name) => name.normalize('NFKC').toLowerCase()
    .replace(QTY_WORDS, '').replace(QTY_TIMES, '').replace(QTY_X, '$1')
    .replace(/[\s\p{P}\p{S}]/gu, '');
  const lowKey = (s) => normKey(s).toLowerCase();

  function findAvoidLike() {
    const f = form.elements;
    const core = coreName(f.name.value);
    const maker = lowKey(f.maker.value);
    const model = lowKey(f.model.value);
    return state.items.filter((it) => it.mark === 'avoid' && it.id !== editingId && (
      (core.length >= 2 && coreName(it.name) === core)
      || (maker && model && lowKey(it.maker) === maker && lowKey(it.model) === model)
    ));
  }
  function checkAvoid() {
    const hits = findAvoidLike();
    const box = $('#avoid-warn');
    box.hidden = hits.length === 0;
    box.replaceChildren(...hits.slice(0, 3).map((it) => {
      const reason = it.avoidReason.length > 200 ? `${it.avoidReason.slice(0, 200)}…` : it.avoidReason;
      return el('p', { text: `「${it.name}」を『もう買わない』で登録しています。理由:${reason || '(理由なし)'}` });
    }));
  }

  /* 品名の候補(新規登録とコピーのフォームだけ) */
  function hideSuggest() {
    const box = $('#name-suggest');
    box.hidden = true;
    box.replaceChildren();
  }
  function updateSuggest() {
    const f = form.elements;
    const q = lowKey(f.name.value);
    if (editingId !== null || q.length < 2) return hideSuggest();
    const qHira = toHira(q);
    const seen = new Set();
    const hits = [];
    for (const it of state.items) {
      const n = lowKey(it.name);
      // 品名どうしは、かなの読み替えをしない部分一致。よみがなは、ひらがなにそろえて部分一致
      if (!n.includes(q) && !(it.yomi && it.yomi.includes(qHira))) continue;
      const key = `${n}\n${it.mark}`;   // 同じ品名・同じ印(期限ちがい)は1件にまとめる
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ it, rank: (it.mark === 'avoid' ? 0 : 2) + (n.startsWith(q) ? 0 : 1) });   // 「もう買わない」を先に(見落とさないため)
    }
    if (hits.length === 0) return hideSuggest();
    hits.sort((a, b) => a.rank - b.rank || byName(a.it, b.it));
    const box = $('#name-suggest');
    box.hidden = false;
    box.replaceChildren(...hits.slice(0, 5).map(({ it }) => el('div', { class: 'sg' }, [
      el('button', {
        type: 'button', class: 'sg-name', 'aria-label': `品名に「${it.name}」を入れる`,
        on: { click: () => { f.name.value = it.name; hideSuggest(); checkAvoid(); saveDraft(); } },
      }, [
        el('span', { text: it.name }),
        it.mark && el('span', { class: `pill ${it.mark}`, text: MARKS[it.mark] }),
      ]),
      el('button', { type: 'button', class: 'btn small', text: 'コピー', 'aria-label': `「${it.name}」をコピーして開く`, on: { click: () => openCopy(it) } }),
    ])));
  }

  /** 「この品をコピー」。同じ内容の新規登録フォームを開く。保存するまで何も作らない */
  function openCopy(src) {
    // 新規登録やコピーのフォームからの乗り換えは、同じフォームの書き直しなので、その下書きは捨てる。
    // 編集フォームからのときは、コピー元の下書きに触らない(コピーを閉じたあとで、続けるか聞く)
    if (dlg.open && (copyMode || editingId === null)) clearDraft();
    const values = {};
    for (const name of FIELDS) values[name] = COPY_BLANK.has(name) ? '' : String(src[name] ?? '');
    openForm(null, { draft: values, copy: true, tags: src.tags.slice() });
  }

  /** 理由の欄は「もう買わない」のときだけ出す */
  function syncMark() {
    $('#avoid-field').hidden = form.elements.mark.value !== 'avoid';
  }

  /** opts.bought = 一覧の「買った」から(印を外した状態で出すだけで、保存するまで何も変えない)。
   *  opts.copy = コピーの新規登録フォーム(opts.draft に中身、opts.tags に引き継ぐタグ) */
  function openForm(item, opts = {}) {
    const { draft = null, bought = false, copy = false, tags = [] } = opts;
    editingId = item ? item.id : null;
    copyMode = copy;
    copyTags = copy ? tags : [];
    $('#dlg-title').textContent = copy ? '品をコピーして追加' : bought ? '買った品を確かめて保存' : item ? '品を編集' : '品を追加';
    $('#b-copy').hidden = !item;
    $('#b-delete').hidden = !item;
    $('#form-error').hidden = true;
    form.reset();
    const f = form.elements;
    const v = item || { genre: 'food', quantity: 1 };
    for (const name of FIELDS) f[name].value = draft ? draft[name] : (v[name] ?? '');
    if (bought) {
      f.mark.value = '';
      if (!(num(f.quantity.value) > 0)) f.quantity.value = '1';
    }
    syncMark();
    form.querySelector('.more').open = Boolean(f.maker.value || f.model.value || f.size.value || f.memo.value);
    const dl = $('#dl-location');
    dl.replaceChildren(...[...new Set(state.items.map((it) => it.location).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja')).map((loc) => el('option', { value: loc })));
    // まとめ名の候補: 使ったことのあるまとめ名(全角/半角だけの違いは1つにまとめる)
    const groups = new Map();
    for (const it of state.items) if (it.group && !groups.has(normKey(it.group))) groups.set(normKey(it.group), it.group);
    $('#dl-group').replaceChildren(...[...groups.values()].sort((a, b) => a.localeCompare(b, 'ja')).map((g) => el('option', { value: g })));
    hideSuggest();
    // 注意は、コピー・「買った」・下書きの続きで開いたときだけ、開いた時点でも確かめる
    if (copy || bought || draft) checkAvoid(); else $('#avoid-warn').hidden = true;
    if (!dlg.open) dlg.showModal();
    dlg.scrollTop = 0;
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
    if (f.mark.value === 'avoid' && !f.avoidReason.value.trim()) return fail('理由を入れてください。', f.avoidReason);
    const old = state.items.find((it) => it.id === editingId);
    const item = sanitizeItem({
      ...(old || {}),
      ...(copyMode ? { tags: copyTags } : {}),
      name: f.name.value, yomi: f.yomi.value, genre: f.genre.value, location: f.location.value,
      quantity: f.quantity.value === '' ? 0 : f.quantity.value, unit: f.unit.value, minQuantity: f.minQuantity.value,
      group: f.group.value, amountPer: f.amountPer.value, amountUnit: f.amountUnit.value,
      mark: f.mark.value, avoidReason: f.avoidReason.value,
      bestBefore: f.bestBefore.value, useBy: f.useBy.value, reviewAt: f.reviewAt.value, leadDays: f.leadDays.value,
      maker: f.maker.value, model: f.model.value, size: f.size.value, memo: f.memo.value,
      updatedAt: new Date().toISOString(),
    }, genreIds());
    if (old) state.items[state.items.indexOf(old)] = item; else state.items.push(item);
    // 数を直したら、在庫不足のスヌーズは解除する
    if (old && old.quantity !== item.quantity) delete state.alerts[`${item.id}|low|`];
    if (save()) {
      closeForm();
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
  form.elements.mark.addEventListener('change', () => {
    syncMark();
    if (form.elements.mark.value === 'buy') checkAvoid();
  });
  // 注意と候補は、日本語入力の確定のとき(入力のたびには出さない)。かな入力を使わない入力は、欄を離れたときに確かめる
  form.elements.name.addEventListener('compositionend', () => { checkAvoid(); updateSuggest(); });
  form.elements.name.addEventListener('input', (ev) => { if (!ev.isComposing) updateSuggest(); });
  for (const name of ['name', 'maker', 'model']) form.elements[name].addEventListener('change', checkAvoid);
  $('#b-copy').addEventListener('click', () => {
    const it = state.items.find((x) => x.id === editingId);
    if (it) openCopy(it);
  });
  form.addEventListener('input', saveDraft);
  form.addEventListener('change', saveDraft);
  // close の知らせは少し遅れて届くので、ボタンで閉じるときはその場でも捨てる(closeForm)
  dlg.addEventListener('close', () => {
    if (dlg.open) return;   // もう次のフォームが開いている
    clearDraft();
    // コピーを閉じたあと、コピー元の書きかけが残っていれば、続けるか聞く
    if (copyMode) { copyMode = false; offerDraft(); }
  });
  $('#b-cancel').addEventListener('click', () => closeForm());
  $('#b-delete').addEventListener('click', () => {
    const it = state.items.find((x) => x.id === editingId);
    if (!it || !confirm(`「${it.name}」を削除します。よろしいですか？`)) return;
    state.items = state.items.filter((x) => x.id !== editingId);
    save();
    closeForm();
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
      groupFilter = null;
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

  /* ---------- ジャンル ---------- */
  /** 絞り込みと登録画面の選択肢を、保存されたジャンルから作り直す(選んでいた値は保つ) */
  function renderGenreOptions() {
    const filter = $('#f-genre');
    const pick = form.elements.genre;
    const ids = genreIds();
    for (const [sel, fallback] of [[filter, ''], [pick, 'other']]) {
      const cur = sel.value;
      const opts = state.genres.map((g) => el('option', { value: g.id, text: g.name }));
      if (sel === filter) opts.unshift(el('option', { value: '', text: 'すべてのジャンル' }));
      sel.replaceChildren(...opts);
      sel.value = ids.has(cur) ? cur : fallback;
    }
  }

  /** 名前が使えるか。使えないときは理由を返す(同じ名前の基準は、合計のまとめ名と同じ) */
  function genreNameProblem(name, selfId) {
    if (!name) return 'ジャンルの名前を入れてください。';
    if (state.genres.some((g) => g.id !== selfId && normKey(g.name) === normKey(name))) return '同じ名前のジャンルがあります。';
    return null;
  }

  function addGenre() {
    const input = $('#g-new');
    const name = str(input.value, GENRE_NAME_MAX);
    const problem = state.genres.length >= GENRE_MAX ? 'ジャンルはこれ以上増やせません。' : genreNameProblem(name, null);
    if (problem) { toast(problem); input.focus(); return; }
    let id = newId('g');
    while (genreIds().has(id)) id = newId('g');
    // 「その他」が最後にあるなら、その手前に入れる
    const last = state.genres.length - 1;
    state.genres.splice(state.genres[last].id === 'other' ? last : last + 1, 0, { id, name });
    input.value = '';
    save();
    renderAll();
    toast(`「${name}」を追加しました`);
  }

  function renameGenre(g, input) {
    const name = str(input.value, GENRE_NAME_MAX);
    if (name === g.name) { input.value = g.name; return; }
    const problem = genreNameProblem(name, g.id);
    if (problem) { input.value = g.name; toast(`${problem}元の名前に戻しました。`); return; }
    g.name = name;
    input.value = name;
    save();
    // 欄は作り直さない(続けて隣のボタンを押したときに、押したボタンが消えないように)
    renderGenreOptions();
    renderList();
    toast('名前を変えました');
  }

  function moveGenre(index, delta) {
    const to = index + delta;
    if (to < 0 || to >= state.genres.length) return;
    const [g] = state.genres.splice(index, 1);
    state.genres.splice(to, 0, g);
    save();
    renderAll();
    $(`#genre-list li:nth-child(${to + 1}) button[data-move="${delta}"]`)?.focus();
  }

  function deleteGenre(g) {
    if (isBuiltinGenre(g.id)) return;
    const used = state.items.filter((it) => it.genre === g.id);
    if (used.length && !confirm(`「${g.name}」には ${used.length}品 あります。「${genreName('other')}」に移して消しますか？`)) return;
    const index = state.genres.indexOf(g);
    for (const it of used) it.genre = 'other';
    state.genres = state.genres.filter((x) => x.id !== g.id);
    save();
    renderAll();
    toast(used.length ? `「${g.name}」を消し、${used.length}品を移しました` : `「${g.name}」を消しました`, {
      label: '取り消す',
      fn: () => {
        if (!genreIds().has(g.id)) state.genres.splice(Math.min(index, state.genres.length), 0, g);
        for (const it of used) if (state.items.includes(it) && it.genre === 'other') it.genre = g.id;
        save();
        renderAll();
      },
    });
  }

  function renderGenres() {
    const ul = $('#genre-list');
    if (ul.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return; // 名前を書いている途中は作り直さない
    const counts = new Map();
    for (const it of state.items) counts.set(it.genre, (counts.get(it.genre) || 0) + 1);
    ul.replaceChildren(...state.genres.map((g, i) => {
      const fixed = isBuiltinGenre(g.id);
      const input = el('input', { value: g.name, maxlength: GENRE_NAME_MAX, autocomplete: 'off', 'aria-label': `「${g.name}」の名前` });
      input.addEventListener('change', () => renameGenre(g, input));
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') input.blur(); });
      return el('li', {}, [
        input,
        el('span', { class: 'count', text: `${counts.get(g.id) || 0}品` }),
        el('button', { type: 'button', class: 'step', text: '↑', 'data-move': -1, disabled: i === 0, 'aria-label': `「${g.name}」を上へ`, on: { click: () => moveGenre(i, -1) } }),
        el('button', { type: 'button', class: 'step', text: '↓', 'data-move': 1, disabled: i === state.genres.length - 1, 'aria-label': `「${g.name}」を下へ`, on: { click: () => moveGenre(i, 1) } }),
        fixed
          ? el('span', { class: 'fixed', text: '消せません' })
          : el('button', { type: 'button', class: 'btn small warn', text: '削除', 'aria-label': `「${g.name}」を削除`, on: { click: () => deleteGenre(g) } }),
      ]);
    }));
  }

  function renderSettings() {
    renderGenres();
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
    renderGenreOptions();
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
    $('#g-add').addEventListener('click', addGenre);
    $('#g-new').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); addGenre(); } });
    document.querySelector('.tabs').addEventListener('click', (ev) => {
      const view = ev.target.closest('button')?.dataset.view;
      if (view) showView(view);
    });
    $('#fab').addEventListener('click', () => openForm(null));
    $('#q').addEventListener('input', renderList);
    $('#f-genre').addEventListener('change', renderList);
    $('#f-location').addEventListener('change', renderList);
    $('#f-mark').addEventListener('change', renderList);
    $('#group-chip-clear').addEventListener('click', () => { groupFilter = null; renderList(); });
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
      clearDraft(DRAFT_KEY);
      clearDraft(COPY_DRAFT_KEY);
      state = normalize(null);
      groupFilter = null;
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
