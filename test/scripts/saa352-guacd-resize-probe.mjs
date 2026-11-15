// Direct guacd probe: connect RDP, then send size changes and log what guacd sends back.
import net from 'node:net';
const [,, gHost, tHost, user, pass, method = 'display-update', ...sizes] = process.argv;
const enc = (...a) => a.map((s) => `${String(s).length}.${s}`).join(',') + ';';
const t0 = Date.now(); const ts = () => ((Date.now() - t0) / 1000).toFixed(2);
const sock = net.connect({ host: gHost, port: 4822 });
let buf = ''; let args = null; let frames = 0; let imgs = 0; let lastSize = null;
const stats = () => `imgs=${imgs} syncs=${frames}`;
sock.on('data', (d) => {
  buf += d.toString('utf8');
  for (;;) {
    const end = parseInstr(buf); if (!end) break;
    buf = buf.slice(end.len); handle(end.parts);
  }
});
function parseInstr(s) {
  const parts = []; let i = 0;
  for (;;) {
    const dot = s.indexOf('.', i); if (dot < 0) return null;
    const n = Number(s.slice(i, dot)); if (s.length < dot + 1 + n + 1) return null;
    parts.push(s.slice(dot + 1, dot + 1 + n)); const term = s[dot + 1 + n]; i = dot + 2 + n;
    if (term === ';') return { parts, len: i };
  }
}
function handle([op, ...a]) {
  if (op === 'args') {
    args = a.slice(1);
    const p = { hostname: tHost, port: process.env.TPORT || '3389', username: user, password: pass, 'ignore-cert': 'true', security: 'any', 'resize-method': method, 'disable-audio': 'true' };
    sock.write(enc('size', 1024, 768, 96) + enc('audio') + enc('video') + enc('image', 'image/png', 'image/jpeg', 'image/webp'));
    sock.write(enc('connect', a[0], ...args.map((k) => p[k] ?? '')));
    return;
  }
  if (op === 'sync') { frames++; sock.write(enc('sync', a[0])); return; }
  if (op === 'img') { imgs++; sock.write(enc('ack', a[0], 'OK', '0')); return; }
  if (op === 'blob') { sock.write(enc('ack', a[0], 'OK', '0')); return; }
  if (op === 'size' && a[0] === '0') { lastSize = `${a[1]}x${a[2]}`; console.log(ts(), 'SIZE layer0', lastSize, stats()); return; }
  if (['ready', 'error', 'disconnect', 'required', 'log'].includes(op)) console.log(ts(), op.toUpperCase(), a.join(' | '));
  if (op === 'nop') sock.write(enc('nop'));
}
sock.write(enc('select', 'rdp'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await wait(6000); console.log(ts(), 'baseline', stats(), 'size', lastSize);
  let x = 10;
  for (const s of sizes) {
    const [w, h] = s.split('x');
    const before = imgs; console.log(ts(), '>>> send size', s);
    sock.write(enc('size', w, h));
    for (let i = 0; i < 8; i++) { await wait(500); x = (x + 37) % 600; sock.write(enc('mouse', x, 200, 0)); }
    console.log(ts(), `after ${s}: layer0=${lastSize} newImgs=${imgs - before}`, stats());
  }
  // input check: type into whatever has focus; mouse movement repaint
  const before = imgs; for (let i = 0; i < 10; i++) { await wait(300); sock.write(enc('mouse', 100 + i * 20, 300, 0)); }
  console.log(ts(), `final mouse-wiggle newImgs=${imgs - before}`, stats(), 'size', lastSize);
  sock.end(); process.exit(0);
})();
