// Bots against a running relay (`npm run dev` here, or the deployed one): a room made, players
// joining it, a team changed, the match started and states relayed. `node bots.mjs [relay] [n]`;
// exits non-zero if anything a player should hear does not come.
const RELAY = process.argv[2] ?? 'http://127.0.0.1:8787';
const N = Number(process.argv[3] ?? 2);
const ORIGIN = 'http://localhost:5173';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function player(code, name) {
  const ws = new WebSocket(`${RELAY.replace(/^http/, 'ws')}/room/${code}`, { headers: { Origin: ORIGIN } });
  const got = [];
  ws.addEventListener('message', (e) => got.push(JSON.parse(e.data)));
  const open = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const send = (m) => ws.send(JSON.stringify(m));
  const last = (t) => [...got].reverse().find((m) => m.t === t);
  const until = async (pred, what, ms = 5000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const m = got.find(pred);
      if (m) return m;
      await sleep(20);
    }
    throw new Error(`${name}: no ${what} in ${ms} ms (got ${got.map((m) => m.t).join(' ')})`);
  };
  return { ws, got, open, send, last, until, name };
}

const made = await fetch(`${RELAY}/rooms`, { method: 'POST', headers: { Origin: ORIGIN } });
if (made.status !== 201) throw new Error(`POST /rooms: ${made.status}`);
const { room } = await made.json();
console.log(`room ${room}`);

const players = [];
for (let i = 0; i < N; i++) {
  const p = player(room, `bot${i}`);
  await p.open;
  p.send({ t: 'hello', v: 1, build: 'bots', name: p.name });
  const w = await p.until((m) => m.t === 'welcome', 'welcome');
  console.log(`${p.name}: seat ${w.you}, owner ${w.owner}, team ${w.seats.find((s) => s.id === w.you).team}`);
  p.you = w.you;
  players.push(p);
}
const host = players[0];
await host.until((m) => m.t === 'roster' && m.seats.length === N, `roster of ${N}`);
players[N - 1].send({ t: 'team', team: 'red' });
await host.until((m) => m.t === 'roster' && m.seats.find((s) => s.id === players[N - 1].you)?.team === 'red', 'team change');

const pings = [];
for (let k = 0; k < 5; k++) {
  const c = Date.now();
  host.send({ t: 'ping', c });
  const pong = await host.until((m) => m.t === 'pong' && m.c === c, 'pong');
  pings.push(Date.now() - pong.c);
}
console.log(`round trips: ${pings.join(', ')} ms`);

host.send({ t: 'start' });
const start = await players[N - 1].until((m) => m.t === 'start', 'start');
console.log(`match starts at ${start.match.startAt}, seed ${start.match.seed}`);
for (let k = 0; k < 20; k++) {
  for (const [i, p] of players.entries()) p.send({ t: 's', s: [k, 1000 * i, 13000, 100000 + k * 50, 0, 0, 0, 9000, 0, 0, 1800, 1] });
  await sleep(50);
}
const frame = players[0].last('f');
if (!frame || frame.ps.length !== N) throw new Error(`frame had ${frame?.ps.length} players`);
console.log(`frames heard by ${players[0].name}: ${players[0].got.filter((m) => m.t === 'f').length}; last has ${frame.ps.map((p) => p[0]).join(', ')}`);

const lost = player('ZZZZZ', 'lost');
await lost.open;
const refused = await lost.until((m) => m.t === 'refused', 'refusal of an unmade room');
console.log(`an unmade room: refused (${refused.reason})`);
for (const p of [...players, lost]) p.ws.close();
console.log('ok');
