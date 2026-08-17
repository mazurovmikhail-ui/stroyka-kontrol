/* Контроль стройки — офлайн-приложение для прораба.
   Всё считается на телефоне, данные никуда не уходят. */

'use strict';

/* ============================================================
   1. Мелкие утилиты
   ============================================================ */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* Числа: 12.5 -> «12,5», 12 -> «12» */
function num(v, dec = 2) {
  if (v == null || !isFinite(v)) return '—';
  const r = Math.round(v * 10 ** dec) / 10 ** dec;
  return String(r).replace('.', ',');
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

const days = n => `${n} ${plural(n, 'день', 'дня', 'дней')}`;

/* Значение для поля ввода: показываем «1,05», а не «1.05» */
const dec = v => (v === '' || v == null) ? '' : String(v).replace('.', ',');

/* Даты — всюду строки «ГГГГ-ММ-ДД», разбор в полдень, чтобы не ловить сдвиг часовых поясов */
const D = {
  parse(s) {
    const [y, m, d] = String(s).split('-').map(Number);
    return new Date(y, m - 1, d, 12, 0, 0, 0);
  },
  iso(dt) {
    const p = n => String(n).padStart(2, '0');
    return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
  },
  today() { return D.iso(new Date()); },
  add(s, n) { return D.iso(new Date(D.parse(s).getTime() + n * 86400000)); },
  diff(a, b) { return Math.round((D.parse(b) - D.parse(a)) / 86400000); },
  ru(s) {
    if (!s) return '—';
    const d = D.parse(s);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
  },
  /* Короткая дата. Год дописываем, если он не текущий: у работ на несколько лет
     «30 ноя» без года читается одинаково для 2026 и 2027. */
  ruShort(s) {
    if (!s) return '—';
    const d = D.parse(s);
    const m = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
    const y = d.getFullYear() === new Date().getFullYear() ? '' : ` ${String(d.getFullYear()).slice(2)}`;
    return `${d.getDate()} ${m[d.getMonth()]}${y}`;
  },
  max(a, b) { return D.parse(a) > D.parse(b) ? a : b; }
};

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2400);
}

/* ============================================================
   2. Хранилище: настройки и записи — в localStorage, фото — в IndexedDB
   ============================================================ */

const KEY = 'stroyka-kontrol-v1';

let S = {
  v: 1,
  projects: [],
  currentId: null,
  works: [],
  materials: [],
  photos: [],
  aiKey: '',
  aiModel: 'qwen/qwen2.5-vl-72b-instruct:free'
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) S = Object.assign(S, JSON.parse(raw));
  } catch (e) {
    console.warn('Не удалось прочитать сохранённые данные', e);
  }
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(S));
  } catch (e) {
    toast('Память телефона заполнена, данные не сохранились');
  }
}

/* Фото — бинарники, им место в IndexedDB, а не в localStorage */
const IDB = {
  _db: null,
  open() {
    if (IDB._db) return Promise.resolve(IDB._db);
    return new Promise((res, rej) => {
      const rq = indexedDB.open('stroyka-photos', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('blobs');
      rq.onsuccess = () => { IDB._db = rq.result; res(IDB._db); };
      rq.onerror = () => rej(rq.error);
    });
  },
  async _tx(mode) {
    const db = await IDB.open();
    return db.transaction('blobs', mode).objectStore('blobs');
  },
  async put(id, blob) {
    const st = await IDB._tx('readwrite');
    return new Promise((res, rej) => {
      const r = st.put(blob, id);
      r.onsuccess = res; r.onerror = () => rej(r.error);
    });
  },
  async get(id) {
    const st = await IDB._tx('readonly');
    return new Promise((res, rej) => {
      const r = st.get(id);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  },
  async del(id) {
    const st = await IDB._tx('readwrite');
    return new Promise(res => { st.delete(id).onsuccess = res; });
  },
  async clear() {
    const st = await IDB._tx('readwrite');
    return new Promise(res => { st.clear().onsuccess = res; });
  }
};

/* Ссылки на картинки живут до следующей перерисовки */
let objectUrls = [];
function urlFor(blob) {
  const u = URL.createObjectURL(blob);
  objectUrls.push(u);
  return u;
}
function revokeUrls() {
  objectUrls.forEach(URL.revokeObjectURL);
  objectUrls = [];
}

/* ============================================================
   3. Выборки
   ============================================================ */

const P = () => S.projects.find(p => p.id === S.currentId) || null;
const works = () => S.works.filter(w => w.pid === S.currentId);
const materials = () => S.materials.filter(m => m.pid === S.currentId);
const photos = () => S.photos.filter(p => p.pid === S.currentId).sort((a, b) => b.ts - a.ts);
const workById = id => S.works.find(w => w.id === id) || null;

/* ============================================================
   4. Расчёты. Здесь вся суть приложения, остальное — обёртка.
   ============================================================ */

/* Темп и прогноз по одной работе */
function workStats(w, today = D.today()) {
  const planQty = Number(w.planQty) || 0;
  const entries = (w.progress || [])
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const fact = entries.length ? Number(entries[entries.length - 1].qty) : 0;
  const lastDate = entries.length ? entries[entries.length - 1].date : w.start;
  const remaining = Math.max(0, planQty - fact);
  const donePct = planQty > 0 ? clamp(fact / planQty, 0, 1) : 0;

  const planDays = Math.max(1, D.diff(w.start, w.end));
  const planPct = clamp(D.diff(w.start, today) / planDays, 0, 1);
  const planVel = planQty / planDays;

  /* Точки для темпа: старт работы считаем нулём, дальше — замеры.
     Берём последние четыре точки: так прогноз реагирует на текущий темп,
     а не размазывает давнюю раскачку по всему сроку. */
  const map = new Map([[w.start, 0]]);
  entries.forEach(e => map.set(e.date, Number(e.qty)));
  const pts = Array.from(map, ([date, qty]) => ({ date, qty }))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-4);

  const spanDays = Math.max(1, D.diff(pts[0].date, pts[pts.length - 1].date));
  const gained = pts[pts.length - 1].qty - pts[0].qty;
  const vel = gained / spanDays;

  let forecastEnd = null;
  let basis = '';
  let stalled = false;

  if (planQty > 0 && remaining <= 0) {
    forecastEnd = lastDate;
    basis = 'работа закрыта';
  } else if (!entries.length) {
    forecastEnd = w.end;
    basis = 'факта ещё нет, прогноз равен плану';
  } else if (vel > 0) {
    forecastEnd = D.add(D.max(today, lastDate), Math.ceil(remaining / vel));
    basis = `по темпу ${num(vel, 2)} ${w.unit || 'ед.'}/день за последние ${days(spanDays)}`;
  } else {
    stalled = true;
    basis = 'за последние замеры прироста нет, срок окончания посчитать не по чему';
  }

  const slip = forecastEnd ? D.diff(w.end, forecastEnd) : null; // > 0 — отставание
  const daysLeft = D.diff(today, w.end);
  const done = planQty > 0 && remaining <= 0;

  /* Отставание в объёме на сегодня: сколько должно быть сделано по плану против факта */
  const shouldBe = planQty * planPct;
  const gapQty = shouldBe - fact;

  let level = 'ok';
  if (done) level = 'ok';
  else if (stalled) level = 'bad';
  else if (slip > 7) level = 'bad';
  else if (slip > 0) level = 'warn';

  return {
    planQty, fact, remaining, donePct, planPct, planDays, planVel,
    vel: vel > 0 ? vel : 0, spanDays, lastDate, forecastEnd, basis,
    slip, daysLeft, done, stalled, gapQty, level, entries
  };
}

/* Прогноз по объекту в целом: сдача не раньше, чем закроется самая поздняя работа */
function projectStats(today = D.today()) {
  const p = P();
  const list = works().map(w => ({ w, st: workStats(w, today) }));
  const open = list.filter(x => !x.st.done);

  let forecastEnd = null;
  let driver = null;
  let unknown = 0;

  open.forEach(({ w, st }) => {
    if (!st.forecastEnd) { unknown++; return; }
    if (!forecastEnd || D.parse(st.forecastEnd) > D.parse(forecastEnd)) {
      forecastEnd = st.forecastEnd;
      driver = w;
    }
  });

  const plannedEnd = p ? p.plannedEnd : null;
  const slip = forecastEnd && plannedEnd ? D.diff(plannedEnd, forecastEnd) : null;
  const daysLeft = plannedEnd ? D.diff(today, plannedEnd) : null;

  const totalPlan = list.reduce((s, x) => s + x.st.planQty, 0);
  const totalDone = list.reduce((s, x) => s + Math.min(x.st.fact, x.st.planQty), 0);
  const donePct = totalPlan > 0 ? totalDone / totalPlan : 0;

  let level = 'ok';
  if (unknown && !forecastEnd) level = 'bad';
  else if (slip > 7) level = 'bad';
  else if (slip > 0) level = 'warn';

  return { list, open, forecastEnd, driver, slip, daysLeft, donePct, unknown, level, plannedEnd };
}

/* Когда и сколько заказывать материал */
function supplyStats(m, today = D.today()) {
  const w = workById(m.wid);
  if (!w) return null;
  const st = workStats(w, today);

  const norm = Number(m.norm) || 0;
  const stock = Number(m.stock) || 0;
  const lead = Number(m.lead) || 0;
  const buffer = Number(m.buffer) || 0;
  const cover = Number(m.cover) || 0;
  const lot = Number(m.lot) || 0;

  /* Расход в день берём по фактическому темпу работы, а пока факта нет — по плановому */
  const byFact = st.vel > 0;
  const vel = byFact ? st.vel : st.planVel;
  const daily = vel * norm;

  const needTotal = st.remaining * norm;          // сколько материала осталось на всю работу
  const stockDays = daily > 0 ? stock / daily : Infinity;
  const runOut = isFinite(stockDays) ? D.add(today, Math.floor(stockDays)) : null;
  const orderBy = runOut ? D.add(runOut, -(lead + buffer)) : null;
  const daysToOrder = orderBy ? D.diff(today, orderBy) : null;

  /* Партия: закрываем срок поставки + запас прочности + горизонт, на который держим склад.
     Больше остатка потребности не заказываем — деньги в бетоне не должны лежать зря. */
  let qty = Math.max(0, daily * (lead + buffer + cover) - stock);
  qty = Math.min(qty, Math.max(0, needTotal - stock));
  if (lot > 0 && qty > 0) qty = Math.ceil(qty / lot) * lot;
  qty = Math.round(qty * 100) / 100;

  const enough = needTotal <= stock;

  let level = 'ok';
  let action = '';
  if (st.done) { level = 'ok'; action = 'работа закрыта'; }
  else if (enough) { level = 'ok'; action = 'запаса хватает до конца работы'; }
  else if (daysToOrder == null) { level = 'warn'; action = 'расход не определён — нет темпа'; }
  else if (daysToOrder < 0) { level = 'bad'; action = `заказ просрочен на ${days(-daysToOrder)}`; }
  else if (daysToOrder <= 2) { level = 'bad'; action = 'заказывать сегодня'; }
  else if (daysToOrder <= 7) { level = 'warn'; action = `заказать через ${days(daysToOrder)}`; }
  else { level = 'ok'; action = `заказать через ${days(daysToOrder)}`; }

  return {
    w, st, daily, byFact, needTotal, stock, stockDays, runOut,
    orderBy, daysToOrder, qty, enough, level, action, lead, buffer, cover, lot, norm
  };
}

/* ============================================================
   5. Общие куски разметки
   ============================================================ */

function bar(donePct, planPct, level) {
  const d = Math.round(clamp(donePct, 0, 1) * 100);
  const p = Math.round(clamp(planPct, 0, 1) * 100);
  return `<div class="bar"><i class="${level}" style="width:${d}%"></i>
    <span class="bar-mark" style="left:calc(${p}% - 1px)"></span></div>
    <div class="bar-legend"><span>факт ${d}%</span><span>план на сегодня ${p}%</span></div>`;
}

/* Короткая подпись на плашке материала. Порог тот же, что у supplyStats.action,
   иначе плашка пишет «через 2 дн.», а карточка — «заказывать сегодня». */
function supplyBadgeText(s) {
  if (s.st.done || s.enough) return 'запаса хватает';
  if (s.daysToOrder == null) return 'нет темпа';
  if (s.daysToOrder <= 2) return 'заказ сейчас';
  return `через ${s.daysToOrder} дн.`;
}

function workBadge(st) {
  if (st.done) return '<span class="badge ok">закрыта</span>';
  if (st.stalled) return '<span class="badge bad">темп нулевой</span>';
  if (st.slip > 0) return `<span class="badge ${st.level}">+${days(st.slip)}</span>`;
  if (st.slip < 0) return `<span class="badge ok">−${days(-st.slip)}</span>`;
  return '<span class="badge ok">в графике</span>';
}

function emptyBox(title, text, btnLabel, btnAction) {
  return `<div class="empty"><h3>${esc(title)}</h3><p>${esc(text)}</p>
    ${btnLabel ? `<button class="btn" data-act="${btnAction}" style="max-width:320px;margin:16px auto 0">${esc(btnLabel)}</button>` : ''}
  </div>`;
}

/* ============================================================
   6. Экраны
   ============================================================ */

let tab = 'summary';

function render() {
  revokeUrls();
  const p = P();
  $('#topProjectName').textContent = p ? p.name : 'Объект не выбран';
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));

  if (!p && tab !== 'settings') {
    $('#view').innerHTML = emptyBox(
      'Объекта пока нет',
      'Создайте объект — дальше по нему заводятся работы, фото и материалы.',
      'Создать объект', 'new-project'
    ) + `<button class="btn ghost" data-act="demo" style="max-width:320px;margin:0 auto">Загрузить демо-объект</button>`;
    bindView();
    return;
  }

  ({ summary: viewSummary, works: viewWorks, photos: viewPhotos, supply: viewSupply, settings: viewSettings }[tab])();
  bindView();
}

/* ---------- Сводка ---------- */

function viewSummary() {
  const ps = projectStats();
  const p = P();
  const ms = materials().map(m => ({ m, s: supplyStats(m) })).filter(x => x.s);
  const urgent = ms.filter(x => x.s.level !== 'ok').sort((a, b) => (a.s.daysToOrder ?? 99) - (b.s.daysToOrder ?? 99));
  const risky = ps.list.filter(x => !x.st.done && (x.st.stalled || x.st.slip > 0))
    .sort((a, b) => (b.st.slip ?? 999) - (a.st.slip ?? 999));
  const dev = photos().filter(x => x.deviation && !x.fixed);

  let hero;
  if (!ps.list.length) {
    hero = `<div class="hero"><div class="hero-label">Прогноз сдачи</div>
      <div class="hero-num">—</div>
      <div class="hero-sub">Пока нет ни одной работы. Прогноз считается по ним.</div></div>`;
  } else if (!ps.forecastEnd) {
    hero = `<div class="hero"><div class="hero-label">Прогноз сдачи</div>
      <div class="hero-num bad">не определён</div>
      <div class="hero-sub">По ${ps.unknown} ${plural(ps.unknown, 'работе', 'работам', 'работам')} нет прироста за последние замеры. Внесите факт — появится прогноз.</div></div>`;
  } else {
    const s = ps.slip;
    const big = s == null ? '—' : s > 0 ? `+${days(s)}` : s < 0 ? `−${days(-s)}` : 'день в день';
    const label = s == null ? '' : s > 0 ? 'отставание от срока сдачи'
      : s < 0 ? 'запас по сроку' : 'ровно в срок';
    const who = ps.driver
      ? (s > 0 ? ` · тянет назад «${esc(ps.driver.name)}»` : ` · последней закрывается «${esc(ps.driver.name)}»`)
      : '';

    let hint = '';
    if (s > 0 && ps.daysLeft != null) {
      hint = ps.daysLeft >= 0
        ? `Сигнал получен за ${days(ps.daysLeft)} до срока сдачи.`
        : `Договорный срок прошёл ${days(-ps.daysLeft)} назад.`;
    } else if (risky.length) {
      hint = `${risky.length} ${plural(risky.length, 'работа выбивается', 'работы выбиваются', 'работ выбиваются')} из своего срока — резерв объекта съедается на них.`;
    }

    hero = `<div class="hero">
      <div class="hero-label">Прогноз сдачи объекта</div>
      <div class="hero-num ${ps.level}">${big}</div>
      <div class="hero-sub">${esc(label)}${who}</div>
      <div class="hero-dates">
        <div><div class="k">По договору</div><div class="v">${D.ru(ps.plannedEnd)}</div></div>
        <div><div class="k">По факту выйдет</div><div class="v">${D.ru(ps.forecastEnd)}</div></div>
      </div>
      ${hint ? `<div class="hint">${hint}</div>` : ''}
      ${ps.unknown ? `<div class="hint">Ещё ${ps.unknown} ${plural(ps.unknown, 'работа стоит', 'работы стоят', 'работ стоят')} без прироста и в прогноз не вошли.</div>` : ''}
    </div>`;
  }

  const done = `<div class="card"><div class="row"><div class="stack grow">
      <div class="name">Выполнено по объекту</div>
      <div class="muted">${ps.list.length} ${plural(ps.list.length, 'работа', 'работы', 'работ')}, закрыто ${ps.list.length - ps.open.length}</div>
    </div><div class="hero-num" style="font-size:26px">${Math.round(ps.donePct * 100)}%</div></div>
    ${bar(ps.donePct, ps.plannedEnd && p.start ? D.diff(p.start, D.today()) / Math.max(1, D.diff(p.start, p.plannedEnd)) : 0, ps.level)}</div>`;

  const riskBlock = risky.length ? `<div class="section-title">Что тянет назад</div>` +
    risky.slice(0, 4).map(({ w, st }) => `
      <div class="card tap" data-act="work" data-id="${w.id}">
        <div class="row top"><div class="stack grow">
          <div class="name">${esc(w.name)}</div>
          <div class="muted">${st.stalled ? 'нет прироста с ' + D.ru(st.lastDate) : 'выйдет ' + D.ru(st.forecastEnd) + ' вместо ' + D.ru(w.end)}</div>
        </div>${workBadge(st)}</div>
        ${bar(st.donePct, st.planPct, st.level)}
      </div>`).join('') : '';

  const supplyBlock = urgent.length ? `<div class="section-title">Заказать материал</div>` +
    urgent.slice(0, 4).map(({ m, s }) => `
      <div class="card tap" data-act="material" data-id="${m.id}">
        <div class="row top"><div class="stack grow">
          <div class="name">${esc(m.name)}</div>
          <div class="muted">${s.qty > 0 ? `${num(s.qty)} ${esc(m.unit)} · ` : ''}${esc(s.action)}</div>
        </div><span class="badge ${s.level}">${esc(supplyBadgeText(s))}</span></div>
      </div>`).join('') : '';

  const devBlock = dev.length ? `<div class="section-title">Открытые отклонения</div>
    <div class="card tap" data-act="tab" data-id="photos">
      <div class="row"><div class="stack grow">
        <div class="name">${dev.length} ${plural(dev.length, 'снимок', 'снимка', 'снимков')} с отметкой «отклонение»</div>
        <div class="muted">Последнее — ${D.ru(dev[0].date)}${dev[0].note ? ': ' + esc(dev[0].note.slice(0, 60)) : ''}</div>
      </div><span class="badge bad">открыто</span></div>
    </div>` : '';

  $('#view').innerHTML = hero + done + riskBlock + supplyBlock + devBlock +
    (!ps.list.length ? `<button class="btn accent" data-act="new-work">Добавить первую работу</button>
      <button class="btn ghost" data-act="demo">Загрузить демо-объект</button>` : '');
}

/* ---------- Работы ---------- */

function viewWorks() {
  const list = works().map(w => ({ w, st: workStats(w) }))
    .sort((a, b) => (a.w.end < b.w.end ? -1 : 1));

  if (!list.length) {
    $('#view').innerHTML = emptyBox(
      'Работ пока нет',
      'Работа — это участок с объёмом и сроком: «Монолит 4 этажа, 320 м³, с 1 по 20 сентября». По объёму и замерам считается темп и прогноз.',
      'Добавить работу', 'new-work'
    );
    return;
  }

  $('#view').innerHTML = list.map(({ w, st }) => `
    <div class="card tap" data-act="work" data-id="${w.id}">
      <div class="row top">
        <div class="stack grow">
          <div class="name">${esc(w.name)}</div>
          <div class="muted">${num(st.fact)} из ${num(st.planQty)} ${esc(w.unit || '')} · срок ${D.ruShort(w.end)}</div>
        </div>
        ${workBadge(st)}
      </div>
      ${bar(st.donePct, st.planPct, st.level)}
    </div>`).join('') +
    `<button class="fab" data-act="new-work" aria-label="Добавить работу">+</button>`;
}

/* ---------- Фото ---------- */

let photoFilter = 'all';

async function viewPhotos() {
  const all = photos();
  const ws = works();
  const list = all.filter(p =>
    photoFilter === 'all' ? true :
    photoFilter === 'dev' ? p.deviation :
    p.wid === photoFilter
  );

  const chips = `<div class="chips">
    <button class="chip ${photoFilter === 'all' ? 'on' : ''}" data-act="pf" data-id="all">Все (${all.length})</button>
    <button class="chip ${photoFilter === 'dev' ? 'on' : ''}" data-act="pf" data-id="dev">Отклонения (${all.filter(p => p.deviation).length})</button>
    ${ws.map(w => `<button class="chip ${photoFilter === w.id ? 'on' : ''}" data-act="pf" data-id="${w.id}">${esc(w.name)}</button>`).join('')}
  </div>`;

  if (!all.length) {
    $('#view').innerHTML = emptyBox(
      'Фотожурнал пуст',
      'Снимок с объекта привязывается к работе и дате. Дальше это доказательная база: что было сделано, когда и где разошлось с проектом.',
      'Снять или выбрать фото', 'new-photo'
    );
    return;
  }

  $('#view').innerHTML = chips +
    (list.length ? `<div class="photo-grid" id="grid"></div>` : `<div class="empty"><p>По этому фильтру снимков нет.</p></div>`) +
    `<button class="fab" data-act="new-photo" aria-label="Добавить фото">+</button>`;

  const grid = $('#grid');
  if (!grid) return;
  for (const ph of list) {
    const cell = document.createElement('div');
    cell.className = 'photo-cell';
    cell.dataset.act = 'photo';
    cell.dataset.id = ph.id;
    const w = workById(ph.wid);
    cell.innerHTML = `${ph.deviation ? '<span class="flag">!</span>' : ''}
      <span class="cap">${D.ruShort(ph.date)}${w ? ' · ' + esc(w.name) : ''}</span>`;
    grid.appendChild(cell);
    IDB.get(ph.id).then(blob => {
      if (!blob) return;
      const img = new Image();
      img.src = urlFor(blob);
      img.alt = ph.note || 'Фото с объекта';
      cell.insertBefore(img, cell.firstChild);
    });
  }
  bindView();
}

/* ---------- Поставки ---------- */

function viewSupply() {
  const list = materials().map(m => ({ m, s: supplyStats(m) })).filter(x => x.s)
    .sort((a, b) => (a.s.daysToOrder ?? 999) - (b.s.daysToOrder ?? 999));

  if (!works().length) {
    $('#view').innerHTML = emptyBox(
      'Сначала работы',
      'График поставок считается от темпа работ: сколько кубов в день льём — столько бетона в день и уходит. Заведите работу, потом материал к ней.',
      'Добавить работу', 'new-work'
    );
    return;
  }

  if (!list.length) {
    $('#view').innerHTML = emptyBox(
      'Материалов пока нет',
      'Материал привязывается к работе: норма расхода на единицу объёма, остаток на складе и срок поставки. Приложение само посчитает, когда и сколько заказывать.',
      'Добавить материал', 'new-material'
    );
    return;
  }

  $('#view').innerHTML = list.map(({ m, s }) => `
    <div class="card tap" data-act="material" data-id="${m.id}">
      <div class="row top">
        <div class="stack grow">
          <div class="name">${esc(m.name)}</div>
          <div class="muted">${esc(s.w.name)}</div>
        </div>
        <span class="badge ${s.level}">${esc(supplyBadgeText(s))}</span>
      </div>
      <div class="kv"><span class="k">Заказать</span><span class="v">${s.qty > 0 ? num(s.qty) + ' ' + esc(m.unit) : '—'}</span></div>
      <div class="kv"><span class="k">На складе</span><span class="v">${num(s.stock)} ${esc(m.unit)}${isFinite(s.stockDays) ? ` · на ${days(Math.floor(s.stockDays))}` : ''}</span></div>
      <div class="kv"><span class="k">Заказ не позже</span><span class="v">${s.orderBy ? D.ru(s.orderBy) : '—'}</span></div>
    </div>`).join('') +
    `<button class="fab" data-act="new-material" aria-label="Добавить материал">+</button>`;
}

/* ---------- Ещё ---------- */

function viewSettings() {
  const p = P();
  const totalPhotos = S.photos.length;

  $('#view').innerHTML = `
    <div class="section-title">Объекты</div>
    ${S.projects.length ? S.projects.map(pr => `
      <div class="card tap" data-act="switch-project" data-id="${pr.id}">
        <div class="row"><div class="stack grow">
          <div class="name">${esc(pr.name)}${pr.id === S.currentId ? ' ·' : ''}</div>
          <div class="muted">${D.ru(pr.start)} — ${D.ru(pr.plannedEnd)}</div>
        </div>${pr.id === S.currentId ? '<span class="badge mute">текущий</span>' : ''}</div>
      </div>`).join('') : '<div class="card"><div class="muted">Объектов нет.</div></div>'}
    <button class="btn ghost" data-act="new-project">Новый объект</button>
    ${p ? `<button class="btn ghost" data-act="edit-project">Изменить «${esc(p.name)}»</button>` : ''}

    <div class="section-title">Данные</div>
    <div class="card">
      <div class="kv"><span class="k">Работ</span><span class="v">${S.works.length}</span></div>
      <div class="kv"><span class="k">Материалов</span><span class="v">${S.materials.length}</span></div>
      <div class="kv"><span class="k">Фотографий</span><span class="v">${totalPhotos}</span></div>
    </div>
    <div class="hint">Всё лежит в памяти браузера на этом телефоне. Никуда не отправляется, но и не синхронизируется: очистите данные сайта — записи пропадут. Раз в неделю делайте выгрузку.</div>
    <button class="btn ghost" data-act="export">Выгрузить данные в файл</button>
    <button class="btn ghost" data-act="import">Загрузить данные из файла</button>
    <button class="btn ghost" data-act="demo">Загрузить демо-объект</button>

    <div class="section-title">Разбор фото нейросетью</div>
    <div class="card">
      <div class="muted">Пока выключен. Приложение считает сроки и поставки само, без интернета — для этого ключ не нужен.
      Разбор снимка нейросетью — единственная функция, которой нужен внешний сервис.</div>
      <label class="f"><span>Ключ OpenRouter (openrouter.ai, начинается на sk-or-)</span>
        <input type="password" id="aiKey" value="${esc(S.aiKey)}" placeholder="не задан" autocomplete="off"></label>
      <label class="f"><span>Модель</span>
        <input type="text" id="aiModel" value="${esc(S.aiModel)}"></label>
      <button class="btn sm ghost" data-act="save-ai" style="width:100%;margin-top:12px">Сохранить ключ</button>
      <div class="hint">Ключ хранится только на этом телефоне. Он подставляется в запрос напрямую из браузера, поэтому заводите ключ с лимитом расходов и не открывайте приложение на чужом устройстве.</div>
    </div>

    <div class="section-title">Опасное</div>
    <button class="btn danger" data-act="wipe">Стереть все данные</button>
    <div class="hint" style="text-align:center;margin:18px 0 0">Контроль стройки · версия 1.0</div>`;
}

/* ============================================================
   7. Модальные окна
   ============================================================ */

function openSheet(title, html) {
  $('#sheetTitle').textContent = title;
  $('#sheetBody').innerHTML = html;
  $('#sheet').hidden = false;
  $('#backdrop').hidden = false;
  bindSheet();
}
function closeSheet() {
  $('#sheet').hidden = true;
  $('#backdrop').hidden = true;
  $('#sheetBody').innerHTML = '';
}

/* ---------- Объект ---------- */

function sheetProject(pr) {
  const isNew = !pr;
  pr = pr || { name: '', start: D.today(), plannedEnd: D.add(D.today(), 180) };
  openSheet(isNew ? 'Новый объект' : 'Объект', `
    <label class="f"><span>Название</span><input id="fName" value="${esc(pr.name)}" placeholder="ЖК Агат, корпус 2"></label>
    <div class="f-two">
      <label class="f"><span>Начало</span><input type="date" id="fStart" value="${pr.start}"></label>
      <label class="f"><span>Сдача по договору</span><input type="date" id="fEnd" value="${pr.plannedEnd}"></label>
    </div>
    <button class="btn accent" data-act="save-project" data-id="${isNew ? '' : pr.id}">Сохранить</button>
    ${isNew ? '' : '<button class="btn danger" data-act="del-project" data-id="' + pr.id + '">Удалить объект со всеми данными</button>'}`);
}

/* ---------- Работа ---------- */

function sheetWorkForm(w) {
  const isNew = !w;
  const p = P();
  w = w || { name: '', unit: 'м³', planQty: '', start: p.start, end: D.add(D.today(), 30) };
  openSheet(isNew ? 'Новая работа' : 'Изменить работу', `
    <label class="f"><span>Что делаем</span><input id="fName" value="${esc(w.name)}" placeholder="Монолит, 4 этаж"></label>
    <div class="f-two">
      <label class="f"><span>Объём по проекту</span><input type="text" inputmode="decimal" id="fQty" value="${dec(w.planQty)}" placeholder="320"></label>
      <label class="f"><span>Единица</span><input id="fUnit" value="${esc(w.unit)}" placeholder="м³"></label>
    </div>
    <div class="f-two">
      <label class="f"><span>Начало</span><input type="date" id="fStart" value="${w.start}"></label>
      <label class="f"><span>Окончание по плану</span><input type="date" id="fEnd" value="${w.end}"></label>
    </div>
    <button class="btn accent" data-act="save-work" data-id="${isNew ? '' : w.id}">Сохранить</button>`);
}

function sheetWork(id) {
  const w = workById(id);
  if (!w) return;
  const st = workStats(w);
  const mats = materials().filter(m => m.wid === w.id);
  const phs = photos().filter(p => p.wid === w.id);

  const forecastLine = st.done
    ? `Закрыта ${D.ru(st.lastDate)}${st.slip > 0 ? `, с опозданием на ${days(st.slip)}` : st.slip < 0 ? `, на ${days(-st.slip)} раньше срока` : ', день в день'}`
    : st.stalled
      ? 'Прогноз не считается: прироста за последние замеры нет'
      : `Выйдет ${D.ru(st.forecastEnd)} при плане ${D.ru(w.end)}`;

  openSheet(w.name, `
    <div class="card">
      <div class="row"><div class="stack grow">
        <div class="name">${num(st.fact)} из ${num(st.planQty)} ${esc(w.unit)}</div>
        <div class="muted">${esc(forecastLine)}</div>
      </div>${workBadge(st)}</div>
      ${bar(st.donePct, st.planPct, st.level)}
    </div>

    <div class="card">
      <div class="kv"><span class="k">Темп</span><span class="v">${st.vel > 0 ? num(st.vel, 2) + ' ' + esc(w.unit) + '/день' : 'нет'}</span></div>
      <div class="kv"><span class="k">Нужен темп, чтобы успеть</span><span class="v">${st.daysLeft > 0 ? num(st.remaining / st.daysLeft, 2) + ' ' + esc(w.unit) + '/день' : '—'}</span></div>
      <div class="kv"><span class="k">Отставание в объёме</span><span class="v">${st.gapQty > 0 ? num(st.gapQty) + ' ' + esc(w.unit) : 'нет'}</span></div>
      <div class="kv"><span class="k">Осталось до срока</span><span class="v">${st.daysLeft >= 0 ? days(st.daysLeft) : 'срок прошёл'}</span></div>
      <div class="formula">Как посчитано: ${esc(st.basis)}. Остаток ${num(st.remaining)} ${esc(w.unit)} делится на темп — получается дата.</div>
    </div>

    <div class="section-title">Замеры выполнения</div>
    ${st.entries.length ? st.entries.slice().reverse().map(e => `
      <div class="card"><div class="row">
        <div class="stack grow"><div class="name">${num(Number(e.qty))} ${esc(w.unit)}</div>
        <div class="muted">${D.ru(e.date)} · нарастающим итогом</div></div>
        <button class="icon-btn" style="background:#eee;color:#b91c1c" data-act="del-entry" data-id="${w.id}" data-sub="${e.date}">✕</button>
      </div></div>`).join('')
      : '<div class="card"><div class="muted">Замеров нет. Внесите, сколько сделано на сегодня — появится темп и прогноз.</div></div>'}
    <button class="btn accent" data-act="add-entry" data-id="${w.id}">Внести факт на сегодня</button>

    ${mats.length ? '<div class="section-title">Материалы этой работы</div>' + mats.map(m => {
      const s = supplyStats(m);
      return `<div class="card tap" data-act="material" data-id="${m.id}"><div class="row">
        <div class="stack grow"><div class="name">${esc(m.name)}</div><div class="muted">${esc(s.action)}</div></div>
        <span class="badge ${s.level}">${s.qty > 0 ? num(s.qty) + ' ' + esc(m.unit) : '—'}</span></div></div>`;
    }).join('') : ''}

    ${phs.length ? `<div class="section-title">Фото</div><div class="card"><div class="muted">${phs.length} ${plural(phs.length, 'снимок', 'снимка', 'снимков')}, из них с отклонениями — ${phs.filter(x => x.deviation).length}.</div></div>` : ''}

    <hr class="sep">
    <button class="btn ghost" data-act="edit-work" data-id="${w.id}">Изменить работу</button>
    <button class="btn danger" data-act="del-work" data-id="${w.id}">Удалить работу</button>`);
}

function sheetEntry(wid) {
  const w = workById(wid);
  const st = workStats(w);
  openSheet('Факт выполнения', `
    <div class="hint" style="margin-top:4px">Вносится накопленный объём — всё, что сделано с начала работы, а не прирост за день. Сейчас в базе ${num(st.fact)} ${esc(w.unit)}.</div>
    <div class="f-two">
      <label class="f"><span>Дата замера</span><input type="date" id="fDate" value="${D.today()}"></label>
      <label class="f"><span>Сделано всего, ${esc(w.unit)}</span><input type="text" inputmode="decimal" id="fQty" value="${dec(st.fact || '')}" placeholder="${num(st.planQty)}"></label>
    </div>
    <button class="btn accent" data-act="save-entry" data-id="${wid}">Сохранить</button>`);
}

/* ---------- Материал ---------- */

function sheetMaterialForm(m) {
  const isNew = !m;
  const ws = works();
  m = m || { name: '', unit: 'т', wid: ws[0] ? ws[0].id : '', norm: '', stock: 0, lead: 7, buffer: 3, cover: 10, lot: 0 };
  openSheet(isNew ? 'Новый материал' : 'Изменить материал', `
    <label class="f"><span>Материал</span><input id="fName" value="${esc(m.name)}" placeholder="Бетон В25"></label>
    <label class="f"><span>К какой работе</span><select id="fWork">
      ${ws.map(w => `<option value="${w.id}" ${w.id === m.wid ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}
    </select></label>
    <div class="f-two">
      <label class="f"><span>Единица</span><input id="fUnit" value="${esc(m.unit)}" placeholder="м³"></label>
      <label class="f"><span>Расход на единицу работы</span><input type="text" inputmode="decimal" id="fNorm" value="${dec(m.norm)}" placeholder="1,05"></label>
    </div>
    <div class="f-two">
      <label class="f"><span>Остаток на складе</span><input type="text" inputmode="decimal" id="fStock" value="${dec(m.stock)}"></label>
      <label class="f"><span>Кратность партии</span><input type="text" inputmode="decimal" id="fLot" value="${dec(m.lot)}" placeholder="0 — любая"></label>
    </div>
    <div class="f-two">
      <label class="f"><span>Срок поставки, дней</span><input type="text" inputmode="numeric" id="fLead" value="${m.lead}"></label>
      <label class="f"><span>Запас прочности, дней</span><input type="text" inputmode="numeric" id="fBuffer" value="${m.buffer}"></label>
    </div>
    <label class="f"><span>На сколько дней держим склад</span><input type="text" inputmode="numeric" id="fCover" value="${m.cover}"></label>
    <div class="hint">Чем больше последнее число, тем реже заказы и тем больше денег заморожено в остатках. 10–14 дней — рабочая середина.</div>
    <button class="btn accent" data-act="save-material" data-id="${isNew ? '' : m.id}">Сохранить</button>`);
}

function sheetMaterial(id) {
  const m = S.materials.find(x => x.id === id);
  if (!m) return;
  const s = supplyStats(m);
  if (!s) return;

  openSheet(m.name, `
    <div class="hero">
      <div class="hero-label">Заказать</div>
      <div class="hero-num ${s.level}">${s.qty > 0 ? num(s.qty) + ' ' + esc(m.unit) : '—'}</div>
      <div class="hero-sub">${esc(s.action)}</div>
      <div class="hero-dates">
        <div><div class="k">Заказ не позже</div><div class="v">${s.orderBy ? D.ru(s.orderBy) : '—'}</div></div>
        <div><div class="k">Склад кончится</div><div class="v">${s.runOut ? D.ru(s.runOut) : '—'}</div></div>
      </div>
    </div>

    <div class="card">
      <div class="kv"><span class="k">Работа</span><span class="v">${esc(s.w.name)}</span></div>
      <div class="kv"><span class="k">Расход</span><span class="v">${num(s.daily, 2)} ${esc(m.unit)}/день</span></div>
      <div class="kv"><span class="k">Считаем по</span><span class="v">${s.byFact ? 'фактическому темпу' : 'плановому темпу'}</span></div>
      <div class="kv"><span class="k">Осталось на работу</span><span class="v">${num(s.needTotal)} ${esc(m.unit)}</span></div>
      <div class="kv"><span class="k">На складе</span><span class="v">${num(s.stock)} ${esc(m.unit)}</span></div>
      <div class="formula">Расход = темп работы × норма ${num(s.norm)} ${esc(m.unit)} на единицу.<br>
        Заказываем на ${s.lead + s.buffer + s.cover} дн. вперёд (поставка ${s.lead} + запас ${s.buffer} + горизонт склада ${s.cover}), минус остаток${s.lot > 0 ? `, с округлением вверх до ${num(s.lot)} ${esc(m.unit)}` : ''}.<br>
        Больше, чем осталось по объёму работы, не заказываем.</div>
    </div>

    <button class="btn ghost" data-act="edit-material" data-id="${m.id}">Изменить</button>
    <button class="btn danger" data-act="del-material" data-id="${m.id}">Удалить материал</button>`);
}

/* ---------- Фото ---------- */

let pendingBlob = null;

function sheetPhotoForm() {
  const ws = works();
  openSheet('Фото с объекта', `
    <label class="f"><span>Снимок</span>
      <input type="file" accept="image/*" capture="environment" id="fFile"></label>
    <div id="prev"></div>
    <label class="f"><span>К какой работе</span><select id="fWork">
      <option value="">без привязки</option>
      ${ws.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}
    </select></label>
    <label class="f"><span>Дата</span><input type="date" id="fDate" value="${D.today()}"></label>
    <label class="f"><span>Что видим</span><textarea id="fNote" placeholder="4 этаж, ось Б-В. Опалубка не выставлена по отметке."></textarea></label>
    <label class="f" style="display:flex;align-items:center;gap:10px">
      <input type="checkbox" id="fDev" style="width:22px;height:22px;flex:0 0 auto">
      <span style="margin:0">Это отклонение от проекта</span></label>
    <button class="btn accent" data-act="save-photo">Сохранить</button>
    ${S.aiKey ? '<button class="btn ghost" data-act="ai-photo">Разобрать снимок нейросетью</button>' : ''}`);
}

async function sheetPhoto(id) {
  const ph = S.photos.find(p => p.id === id);
  if (!ph) return;
  const w = workById(ph.wid);
  openSheet('Снимок', `
    <div id="full"></div>
    <div class="card" style="margin-top:10px">
      <div class="kv"><span class="k">Дата</span><span class="v">${D.ru(ph.date)}</span></div>
      <div class="kv"><span class="k">Работа</span><span class="v">${w ? esc(w.name) : '—'}</span></div>
      <div class="kv"><span class="k">Статус</span><span class="v">${ph.deviation ? (ph.fixed ? 'отклонение устранено' : 'отклонение открыто') : 'штатный снимок'}</span></div>
    </div>
    ${ph.note ? `<div class="card"><div class="muted">${esc(ph.note)}</div></div>` : ''}
    ${ph.ai ? `<div class="card"><div class="tiny">Разбор нейросетью</div><div class="muted" style="margin-top:6px;white-space:pre-wrap">${esc(ph.ai)}</div></div>` : ''}
    ${ph.deviation ? `<button class="btn ghost" data-act="toggle-fixed" data-id="${ph.id}">${ph.fixed ? 'Вернуть в открытые' : 'Отметить как устранённое'}</button>` : ''}
    <button class="btn danger" data-act="del-photo" data-id="${ph.id}">Удалить снимок</button>`);

  const blob = await IDB.get(ph.id);
  if (blob && $('#full')) {
    const img = new Image();
    img.className = 'photo-full';
    img.src = urlFor(blob);
    $('#full').appendChild(img);
  }
}

/* Сжатие: 1400 px по длинной стороне, JPEG 0,72 — читаемо и не забивает память */
function compress(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 1400;
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k);
        c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        c.toBlob(b => b ? res(b) : rej(new Error('Не удалось обработать снимок')), 'image/jpeg', 0.72);
      };
      img.onerror = () => rej(new Error('Файл не похож на изображение'));
      img.src = fr.result;
    };
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(file);
  });
}

/* Разбор снимка через OpenRouter. Работает, только если пользователь завёл свой ключ. */
async function analyzePhoto(blob) {
  if (!S.aiKey) throw new Error('Ключ не задан');
  const b64 = await new Promise(res => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.readAsDataURL(blob);
  });
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.aiKey },
    body: JSON.stringify({
      model: S.aiModel,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Это фото строительной площадки. Опиши коротко и по делу: какие конструкции и работы видны, на какой стадии, что выглядит нарушением норм или проекта. Без вступлений, 5–7 пунктов списком. Если по фото чего-то не видно — так и скажи, не додумывай.' },
          { type: 'image_url', image_url: { url: b64 } }
        ]
      }]
    })
  });
  if (!r.ok) throw new Error('Сервис ответил ошибкой ' + r.status);
  const j = await r.json();
  return j.choices?.[0]?.message?.content || 'Пустой ответ';
}

/* ============================================================
   8. Демо-объект — чтобы сразу увидеть, как считается

   Взят реальный объект: ЖК «Исторический», башня «Мир».
   Владивосток, ул. Снеговая, 9. Застройщик ООО СЗ «Строй Проект» (ГК С.АН ГРУПП).
   Срок передачи ключей — II квартал 2028 (сайт застройщика, август 2026).
   Состав и объёмы работ, нормы расхода и остатки на складе — прикидка под
   25-этажную монолитно-кирпичную башню, у застройщика они свои.
   Даты замеров отсчитываются от сегодня, чтобы демо не протухало.
   ============================================================ */

function loadDemo() {
  const t = D.today();
  const pid = uid();
  S.projects.push({
    id: pid,
    name: 'ЖК Исторический, башня «Мир»',
    start: '2025-11-10',
    plannedEnd: '2028-06-30'
  });
  S.currentId = pid;

  const w1 = uid(), w2 = uid(), w3 = uid(), w4 = uid(), w5 = uid();
  S.works.push(
    {
      id: w1, pid, name: 'Монолитный каркас, эт. 1–25', unit: 'м³', planQty: 12400,
      start: '2025-11-10', end: '2026-11-30',
      progress: [
        { date: D.add(t, -78), qty: 5100 },
        { date: D.add(t, -48), qty: 6180 },
        { date: D.add(t, -17), qty: 7180 },
        { date: D.add(t, -3), qty: 7860 }
      ]
    },
    {
      id: w2, pid, name: 'Кладка стен и перегородок', unit: 'м²', planQty: 9800,
      start: '2026-04-01', end: '2027-03-31',
      progress: [
        { date: D.add(t, -48), qty: 2100 },
        { date: D.add(t, -17), qty: 3050 },
        { date: D.add(t, -3), qty: 3600 }
      ]
    },
    {
      id: w3, pid, name: 'Фасад навесной вентилируемый', unit: 'м²', planQty: 11200,
      start: '2026-07-15', end: '2027-06-30',
      progress: [
        { date: D.add(t, -17), qty: 520 },
        { date: D.add(t, -3), qty: 980 }
      ]
    },
    {
      id: w4, pid, name: 'Инженерные сети и стояки', unit: 'м', planQty: 24800,
      start: '2027-01-15', end: '2027-11-30', progress: []
    },
    {
      id: w5, pid, name: 'Отделка МОП и квартир', unit: 'м²', planQty: 21300,
      start: '2027-06-01', end: '2028-05-31', progress: []
    }
  );

  S.materials.push(
    { id: uid(), pid, wid: w1, name: 'Бетон В30 W6', unit: 'м³', norm: 1.02, stock: 220, lead: 2, buffer: 1, cover: 7, lot: 6 },
    { id: uid(), pid, wid: w1, name: 'Арматура А500С', unit: 'т', norm: 0.105, stock: 96, lead: 14, buffer: 5, cover: 14, lot: 1 },
    { id: uid(), pid, wid: w2, name: 'Газобетонный блок D500', unit: 'м³', norm: 0.11, stock: 84, lead: 7, buffer: 3, cover: 10, lot: 2 },
    { id: uid(), pid, wid: w3, name: 'Керамогранит фасадный', unit: 'м²', norm: 1.05, stock: 1250, lead: 21, buffer: 7, cover: 21, lot: 10 }
  );

  save();
  tab = 'summary';
  render();
  toast('Загружен объект: башня «Мир»');
}

/* ============================================================
   9. Экспорт и импорт
   ============================================================ */

function exportData() {
  const data = JSON.stringify({ ...S, exportedAt: new Date().toISOString() }, null, 1);
  const blob = new Blob([data], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `stroyka-${D.today()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('Файл выгружен. Фотографии в него не входят');
}

function importData() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'application/json,.json';
  inp.onchange = () => {
    const f = inp.files[0];
    if (!f) return;
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const d = JSON.parse(fr.result);
        if (!d.projects) throw new Error('нет объектов');
        if (!confirm('Загруженные данные заменят текущие. Продолжить?')) return;
        S = Object.assign(S, d);
        save();
        render();
        toast('Данные загружены');
      } catch (e) {
        toast('Файл не читается: ' + e.message);
      }
    };
    fr.readAsText(f);
  };
  inp.click();
}

/* ============================================================
   10. Обработчики
   ============================================================ */

function val(id) { const e = $('#' + id); return e ? e.value.trim() : ''; }

/* Поля с числами сделаны текстовыми: на русской клавиатуре «1,05» набирается через запятую,
   а type="number" такое значение молча выбрасывает. NaN отдаём наружу, чтобы проверки его поймали. */
function numVal(id) {
  const v = val(id).replace(',', '.');
  if (v === '') return 0;
  const n = Number(v);
  return isFinite(n) ? n : NaN;
}

const actions = {
  tab(id) { tab = id; render(); },

  'new-project'() { sheetProject(null); },
  'edit-project'() { sheetProject(P()); },
  'switch-project'(id) { S.currentId = id; save(); tab = 'summary'; render(); },
  'save-project'(id) {
    const name = val('fName');
    if (!name) return toast('Название не заполнено');
    const start = val('fStart'), end = val('fEnd');
    if (D.diff(start, end) <= 0) return toast('Сдача должна быть позже начала');
    if (id) {
      const pr = S.projects.find(x => x.id === id);
      Object.assign(pr, { name, start, plannedEnd: end });
    } else {
      const pr = { id: uid(), name, start, plannedEnd: end };
      S.projects.push(pr);
      S.currentId = pr.id;
    }
    save(); closeSheet(); render();
  },
  async 'del-project'(id) {
    if (!confirm('Удалить объект вместе с работами, материалами и фото?')) return;
    const phs = S.photos.filter(p => p.pid === id);
    for (const p of phs) await IDB.del(p.id);
    S.photos = S.photos.filter(p => p.pid !== id);
    S.works = S.works.filter(w => w.pid !== id);
    S.materials = S.materials.filter(m => m.pid !== id);
    S.projects = S.projects.filter(p => p.id !== id);
    if (S.currentId === id) S.currentId = S.projects[0] ? S.projects[0].id : null;
    save(); closeSheet(); render();
  },

  'new-work'() { sheetWorkForm(null); },
  work(id) { sheetWork(id); },
  'edit-work'(id) { sheetWorkForm(workById(id)); },
  'save-work'(id) {
    const name = val('fName');
    const qty = numVal('fQty');
    const start = val('fStart'), end = val('fEnd');
    if (!name) return toast('Название не заполнено');
    if (!(qty > 0)) return toast('Объём должен быть числом больше нуля');
    if (D.diff(start, end) <= 0) return toast('Окончание должно быть позже начала');
    if (id) {
      Object.assign(workById(id), { name, unit: val('fUnit') || 'ед.', planQty: qty, start, end });
    } else {
      S.works.push({ id: uid(), pid: S.currentId, name, unit: val('fUnit') || 'ед.', planQty: qty, start, end, progress: [] });
    }
    save(); closeSheet(); render();
  },
  async 'del-work'(id) {
    if (!confirm('Удалить работу? Материалы, привязанные к ней, тоже удалятся.')) return;
    S.works = S.works.filter(w => w.id !== id);
    S.materials = S.materials.filter(m => m.wid !== id);
    S.photos.forEach(p => { if (p.wid === id) p.wid = ''; });
    save(); closeSheet(); render();
  },

  'add-entry'(id) { sheetEntry(id); },
  'save-entry'(id) {
    const w = workById(id);
    const date = val('fDate');
    const qty = numVal('fQty');
    if (!date) return toast('Дата не заполнена');
    if (!(qty >= 0)) return toast('Объём должен быть числом не меньше нуля');
    if (D.diff(w.start, date) < 0) return toast('Замер раньше начала работы');
    w.progress = (w.progress || []).filter(e => e.date !== date);
    w.progress.push({ date, qty });
    w.progress.sort((a, b) => (a.date < b.date ? -1 : 1));
    save(); sheetWork(id); render();
    toast('Факт внесён');
  },
  'del-entry'(id, date) {
    const w = workById(id);
    w.progress = w.progress.filter(e => e.date !== date);
    save(); sheetWork(id); render();
  },

  'new-material'() {
    if (!works().length) return toast('Сначала заведите работу');
    sheetMaterialForm(null);
  },
  material(id) { sheetMaterial(id); },
  'edit-material'(id) { sheetMaterialForm(S.materials.find(m => m.id === id)); },
  'save-material'(id) {
    const name = val('fName');
    const wid = val('fWork');
    const norm = numVal('fNorm');
    if (!name) return toast('Название не заполнено');
    if (!wid) return toast('Выберите работу');
    if (!(norm > 0)) return toast('Норма расхода должна быть числом больше нуля');
    const data = {
      name, wid, unit: val('fUnit') || 'ед.', norm,
      stock: numVal('fStock'), lot: numVal('fLot'),
      lead: numVal('fLead'), buffer: numVal('fBuffer'), cover: numVal('fCover')
    };
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'number' && !(v >= 0)) return toast('Числовые поля заполнены неверно');
    }
    if (id) Object.assign(S.materials.find(m => m.id === id), data);
    else S.materials.push(Object.assign({ id: uid(), pid: S.currentId }, data));
    save(); closeSheet(); render();
  },
  'del-material'(id) {
    if (!confirm('Удалить материал?')) return;
    S.materials = S.materials.filter(m => m.id !== id);
    save(); closeSheet(); render();
  },

  pf(id) { photoFilter = id; render(); },
  'new-photo'() { pendingBlob = null; sheetPhotoForm(); },
  photo(id) { sheetPhoto(id); },
  async 'save-photo'() {
    if (!pendingBlob) return toast('Снимок не выбран');
    const id = uid();
    await IDB.put(id, pendingBlob);
    S.photos.push({
      id, pid: S.currentId, wid: val('fWork'), date: val('fDate') || D.today(),
      note: $('#fNote') ? $('#fNote').value.trim() : '',
      deviation: $('#fDev').checked, fixed: false, ts: Date.now(),
      ai: pendingAi || ''
    });
    pendingBlob = null; pendingAi = '';
    save(); closeSheet(); render();
    toast('Снимок сохранён');
  },
  async 'del-photo'(id) {
    if (!confirm('Удалить снимок?')) return;
    await IDB.del(id);
    S.photos = S.photos.filter(p => p.id !== id);
    save(); closeSheet(); render();
  },
  'toggle-fixed'(id) {
    const p = S.photos.find(x => x.id === id);
    p.fixed = !p.fixed;
    save(); sheetPhoto(id); render();
  },
  async 'ai-photo'(_, __, btn) {
    if (!pendingBlob) return toast('Сначала выберите снимок');
    btn.textContent = 'Разбираю…';
    btn.disabled = true;
    try {
      pendingAi = await analyzePhoto(pendingBlob);
      const box = document.createElement('div');
      box.className = 'card';
      box.style.marginTop = '10px';
      box.innerHTML = `<div class="tiny">Разбор нейросетью</div><div class="muted" style="margin-top:6px;white-space:pre-wrap">${esc(pendingAi)}</div>`;
      btn.after(box);
      btn.remove();
    } catch (e) {
      toast('Не вышло: ' + e.message);
      btn.textContent = 'Разобрать снимок нейросетью';
      btn.disabled = false;
    }
  },

  'save-ai'() {
    S.aiKey = val('aiKey');
    S.aiModel = val('aiModel') || S.aiModel;
    save();
    toast(S.aiKey ? 'Ключ сохранён на этом устройстве' : 'Ключ убран');
  },

  demo() { loadDemo(); },
  export: exportData,
  import: importData,
  async wipe() {
    if (!confirm('Стереть все объекты, работы, материалы и фото? Отменить будет нельзя.')) return;
    await IDB.clear();
    localStorage.removeItem(KEY);
    S = { v: 1, projects: [], currentId: null, works: [], materials: [], photos: [], aiKey: '', aiModel: S.aiModel };
    render();
    toast('Данные стёрты');
  }
};

let pendingAi = '';

function delegate(root) {
  root.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el || !root.contains(el)) return;
    const fn = actions[el.dataset.act];
    if (!fn) return;
    e.preventDefault();
    fn(el.dataset.id, el.dataset.sub, el);
  });
}

function bindView() { /* делегирование навешено один раз, отдельная привязка не нужна */ }
function bindSheet() {
  const f = $('#fFile');
  if (!f) return;
  f.addEventListener('change', async () => {
    const file = f.files[0];
    if (!file) return;
    try {
      pendingBlob = await compress(file);
      pendingAi = '';
      const prev = $('#prev');
      prev.innerHTML = '';
      const img = new Image();
      img.className = 'photo-full';
      img.style.marginTop = '10px';
      img.src = urlFor(pendingBlob);
      prev.appendChild(img);
    } catch (err) {
      toast(err.message);
    }
  });
}

/* ============================================================
   11. Запуск
   ============================================================ */

function init() {
  load();
  if (S.projects.length && !S.projects.find(p => p.id === S.currentId)) {
    S.currentId = S.projects[0].id;
  }

  delegate($('#view'));
  delegate($('#sheetBody'));

  $('#tabbar').addEventListener('click', e => {
    const b = e.target.closest('.tab');
    if (!b) return;
    tab = b.dataset.tab;
    render();
  });

  $('#btnProjects').addEventListener('click', () => { tab = 'settings'; render(); });
  $('#sheetClose').addEventListener('click', closeSheet);
  $('#backdrop').addEventListener('click', closeSheet);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

  render();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
