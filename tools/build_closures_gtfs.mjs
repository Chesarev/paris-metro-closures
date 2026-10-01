/*
 * Закрытые станции из официального расписания IDFM — без ключа API.
 *
 * Расписание GTFS (data.iledefrance-mobilites.fr, обновляется каждый день и
 * покрывает ближайшие 30 дней) уже учитывает запланированные работы: если станция
 * закрыта, поезда в ней не останавливаются и в stop_times её просто нет. Сравниваем
 * дни, когда линия ходит, с днями, когда на станции останавливается хоть один поезд.
 *
 * Выход — closures.json в формате vector/js/closures.js; у записей есть from/until,
 * так что приложение само включает будущие закрытия в нужный день.
 *   blocked=false — поезда станцию проезжают без остановки;
 *   blocked=true  — поездов через неё нет совсем (участок закрыт).
 *
 *   node tools/build_closures_gtfs.mjs [--gtfs папка] [--out closures.json] [--days 30] [--snapshot файл.js]
 *
 * Не ловит: внезапные происшествия и задержки этого часа (их знает только API
 * реального времени, а он требует ключ), и закрытия, которые длятся всё окно целиком
 * (станция ни разу не обслуживается — отличить от «её нет в расписании» нельзя).
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const DIR = arg('gtfs', path.join(root, 'idfm-gtfs'));
const OUT = arg('out', 'closures.json');
const DAYS = +arg('days', 30);
const SNAP = arg('snapshot', '');          // необязательно: JS-снимок для вшивания в приложение
const G = f => path.join(DIR, f);

const splitCsv = line => {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out;
};
async function* rows(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let head = null;
  for await (const l of rl) { if (!l) continue; if (!head) { head = splitCsv(l.replace(/^﻿/, '')); continue; } yield { head, c: splitCsv(l) }; }
}
const col = (head, n) => head.indexOf(n);

/* ---- окно дат (по Парижу) ---- */
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
const today = new Date(new Date().toLocaleDateString('sv', { timeZone: 'Europe/Paris' }) + 'T00:00:00Z');
const dates = Array.from({ length: DAYS }, (_, i) => ymd(new Date(today.getTime() + i * 864e5)));
const dow = s => new Date(s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6) + 'T00:00:00Z').getUTCDay();

/* ---- service_id → множество дат окна ---- */
const svcDates = new Map();
for await (const { head, c } of rows(G('calendar.txt'))) {
  const id = c[col(head, 'service_id')], s = c[col(head, 'start_date')], e = c[col(head, 'end_date')];
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map(n => c[col(head, n)] === '1');
  const set = new Set();
  dates.forEach(d => { if (d >= s && d <= e && days[dow(d)]) set.add(d); });
  svcDates.set(id, set);
}
for await (const { head, c } of rows(G('calendar_dates.txt'))) {
  const id = c[col(head, 'service_id')], d = c[col(head, 'date')], t = c[col(head, 'exception_type')];
  if (!dates.includes(d)) continue;
  if (!svcDates.has(id)) svcDates.set(id, new Set());
  t === '1' ? svcDates.get(id).add(d) : svcDates.get(id).delete(d);
}

/* ---- линии метро и RER A–E ---- */
const lineOfRoute = new Map();
for await (const { head, c } of rows(G('routes.txt'))) {
  const type = c[col(head, 'route_type')], short = c[col(head, 'route_short_name')];
  let code = null;
  if (type === '1') code = short.replace('3B', '3bis').replace('7B', '7bis');
  else if (type === '2' && /^[ABCDE]$/.test(short)) code = short;
  if (code) lineOfRoute.set(c[col(head, 'route_id')], { code, rer: type === '2' });
}
const tripInfo = new Map();                     // trip_id → {line, service}
for await (const { head, c } of rows(G('trips.txt'))) {
  const l = lineOfRoute.get(c[col(head, 'route_id')]);
  if (l) tripInfo.set(c[col(head, 'trip_id')], { line: l.code, rer: l.rer, svc: c[col(head, 'service_id')] });
}

/* ---- остановки → станция (родитель) ---- */
const stops = new Map();
for await (const { head, c } of rows(G('stops.txt')))
  stops.set(c[col(head, 'stop_id')], { name: c[col(head, 'stop_name')].trim(), parent: c[col(head, 'parent_station')] });
const stationOf = id => { let s = stops.get(id), g = 0; while (s && s.parent && stops.has(s.parent) && g++ < 4) s = stops.get(s.parent); return s && s.name; };

/* ---- stop_times: какие услуги останавливаются на станции, и пары соседних остановок ---- */
const served = new Map();                        // line|станция → Set(service)
const pairs = new Map();                         // line|услуга → Set('a>b')
let prev = null, n = 0;
const rl = readline.createInterface({ input: fs.createReadStream(G('stop_times.txt')), crlfDelay: Infinity });
let iStop = 3, iSeq = 4, first = true;
for await (const line of rl) {
  if (first) { const h = splitCsv(line.replace(/^﻿/, '')); iStop = h.indexOf('stop_id'); iSeq = h.indexOf('stop_sequence'); first = false; continue; }
  const comma = line.indexOf(',');
  const info = tripInfo.get(line.slice(0, comma));
  if (!info) { prev = null; continue; }
  const f = line.split(',', Math.max(iStop, iSeq) + 1);
  const name = stationOf(f[iStop]);
  if (!name) continue;
  const k = info.line + '|' + name;
  (served.get(k) || served.set(k, new Set()).get(k)).add(info.svc);
  if (prev && prev.trip === line.slice(0, comma) && prev.name !== name) {
    const pk = info.line + '|' + info.svc;
    (pairs.get(pk) || pairs.set(pk, new Set()).get(pk)).add(prev.name + '>' + name);
  }
  prev = { trip: line.slice(0, comma), name };
  if (++n % 5e6 === 0) console.error((n / 1e6) + 'M строк');
}

/* ---- дни работы линии и дни обслуживания станции ---- */
const lineDays = new Map(), lineSvcs = new Map(), rerLines = new Set();
tripInfo.forEach(t => {
  if (t.rer) rerLines.add(t.line);
  if (!lineSvcs.has(t.line)) lineSvcs.set(t.line, new Set());
  lineSvcs.get(t.line).add(t.svc);
});
lineSvcs.forEach((svcs, line) => {
  const s = new Set(); svcs.forEach(id => (svcDates.get(id) || []).forEach(d => s.add(d))); lineDays.set(line, s);
});
const daysOf = svcs => { const s = new Set(); svcs.forEach(id => (svcDates.get(id) || []).forEach(d => s.add(d))); return s; };

/* соседи станции по линии в нормальном движении */
const neigh = new Map();
pairs.forEach((set, pk) => {
  const line = pk.split('|')[0];
  set.forEach(p => { const [a, b] = p.split('>'); [[a, b], [b, a]].forEach(([x, y]) => {
    const k = line + '|' + x; (neigh.get(k) || neigh.set(k, new Set()).get(k)).add(y); }); });
});

const closed = [];
const iso = d => d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6) + 'T00:00:00Z';
const nextDay = d => ymd(new Date(new Date(iso(d)).getTime() + 864e5));
served.forEach((svcs, k) => {
  const [line, name] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)];
  const ld = lineDays.get(line); if (!ld) return;
  const sd = daysOf(svcs);
  const off = dates.filter(d => ld.has(d) && !sd.has(d));
  if (!off.length || off.length === [...ld].length) return;       // всё окно закрыто — не отличить от отсутствия в расписании
  if (rerLines.has(line)) {                                       // у RER бывают «только будни» — это не закрытие
    for (const cls of [[6], [0], [1, 2, 3, 4, 5]]) {
      const all = [...ld].filter(d => cls.includes(dow(d)));
      if (all.length && all.every(d => off.includes(d))) return;
    }
  }
  // подряд идущие дни → интервалы
  let run = null;
  const flush = () => { if (!run) return;
    // проезжают ли поезда сквозь станцию в эти дни: есть пара соседей, между которыми она стоит
    const nb = [...(neigh.get(line + '|' + name) || [])];
    const through = run.days.some(d => {
      const svc = [...lineSvcs.get(line)].filter(id => (svcDates.get(id) || new Set()).has(d));
      return svc.some(id => { const ps = pairs.get(line + '|' + id); return ps && nb.some(a => nb.some(b => a !== b && ps.has(a + '>' + b))); });
    });
    closed.push({ name, lines: [line], reason: 'travaux (horaires GTFS IDFM)', from: iso(run.days[0]), until: iso(nextDay(run.days[run.days.length - 1])), blocked: !through });
    run = null; };
  dates.forEach(d => {
    if (!ld.has(d)) return;                                       // линия не ходит — день не считаем
    if (off.includes(d)) { if (!run) run = { days: [] }; run.days.push(d); } else flush();
  });
  flush();
});

closed.sort((a, b) => a.from.localeCompare(b.from) || a.name.localeCompare(b.name));
fs.writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), closed }));
if (SNAP) fs.writeFileSync(SNAP, '/* снимок закрытий на момент сборки; сгенерирован tools/build_closures_gtfs.mjs */' + String.fromCharCode(10) + 'window.PARIS_CLOSURES_SNAPSHOT = ' + JSON.stringify({ updated: new Date().toISOString(), closed }) + ';' + String.fromCharCode(10));
console.log('закрытий:', closed.length, '→', OUT);
closed.slice(0, 15).forEach(c => console.log(' ', c.lines[0], c.name, c.from.slice(0, 10), '→', c.until.slice(0, 10), c.blocked ? 'участок' : 'проезд без остановки'));
