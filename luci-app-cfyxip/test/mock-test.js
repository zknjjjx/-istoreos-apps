// 用假的 LuCI 环境跑一遍 cfyxip.js：load → render → 按钮 → 刷新，检查不会抛错
global.window = global;
const src = require('fs').readFileSync(process.argv[2] || 'root/www/luci-static/resources/view/cfyxip.js', 'utf8');
function Node(tag, a, k) { this.tag = tag; this.attrs = a || {}; this.children = []; this.value = ''; this.scrollTop = 0; this.clientHeight = 0; this.scrollHeight = 0; if (k !== undefined) this.add(k); }
Node.prototype.add = function(k) { if (Array.isArray(k)) k.forEach(x => this.add(x)); else if (k !== '' && k != null) this.children.push(k); };
Node.prototype.appendChild = function(c) { this.children.push(c); return c; };
Node.prototype.removeChild = function(c) { this.children.splice(this.children.indexOf(c), 1); };
Object.defineProperty(Node.prototype, 'firstChild', { get() { return this.children[0]; } });
Node.prototype.text = function() { return this.children.map(c => c instanceof Node ? c.text() : String(c)).join(''); };
global.E = (t, a, k) => { if (Array.isArray(a) || typeof a !== 'object' || a instanceof Node) { k = a; a = {}; } return new Node(t, a, k); };
global.L = { resolveDefault: (p, d) => p.catch(() => d) };
const opts = [];
class Opt { constructor(type, name, title, desc) { Object.assign(this, { type, name, title, desc, vals: [] }); opts.push(this); } value(k, v) { this.vals.push([k, v]); } depends() {} }
const section = { tab() {}, taboption(tab, type, name, title, desc) { const o = new Opt(type, name, title, desc); o.tab = tab; o.map = { data: { get: (c, s, k) => ({ gh_repo: 'zknjjjx/cf-preferred-ip' })[k] } }; return o; } };
const form = { Map: function() { this.section = () => section; this.render = () => Promise.resolve(E('div', {}, 'FORM')); }, NamedSection: 1, Value: 'Value', Flag: 'Flag', MultiValue: 'MultiValue', DynamicList: 'DynamicList', DummyValue: 'DummyValue', Button: 'Button' };
let running = true;
const fs = { exec: (b, args) => {
	let out = {};
	if (args[0] == 'status') out = { running, status: { state: running ? 'running' : 'done', phase: 'TCP 延迟测试', done: 50, total: 100, found: 7 }, last: 1791867000, count: 2, cron: 1, version: '1.0.0-r1', now: 1791867100 };
	else if (args[0] == 'result') out = { results: [{ ip: '104.17.69.180', port: 443, latency: 167.2, http_ms: 380, colo: 'LAX', cc: 'US', country: '美国', city: 'Los Angeles', speed: 16.88, checks: 3 }] };
	else if (args[0] == 'colos') out = [{ Code: 'US', Name: '美国', Colos: ['LAX Los Angeles'] }, { Code: 'HK', Name: '香港', Colos: ['HKG Hong Kong'] }];
	else if (args[0] == 'log' || args[0] == 'txt') return Promise.resolve({ stdout: '104.17.69.180:443#LAX 16.88MB/s 167ms\n' });
	else out = { ok: true };
	return Promise.resolve({ stdout: JSON.stringify(out) });
} };
let polled = null;
const ui = { addNotification() {}, showModal() {}, hideModal() {}, createHandlerFn: (c, f) => f };
const poll = { add: f => { polled = f; } };
const view = { extend: o => o };
const V = new Function('view', 'form', 'fs', 'ui', 'poll', src.replace(/^'use strict';/, ''))(view, form, fs, ui, poll);
(async () => {
	const d = await V.load();
	const el = await V.render(d);
	const txt = el.text();
	for (const w of ['扫描中', '104.17.69.180:443', '美国 US', '16.88 MB/s', 'FORM']) if (!txt.includes(w)) throw new Error('缺少：' + w);
	const noHint = opts.filter(o => o.type != 'DummyValue' && !o.desc);
	if (noHint.length) throw new Error('这些设置没有说明：' + noHint.map(o => o.name));
	if (!opts.find(o => o.name == 'countries').vals.length) throw new Error('国家列表为空');
	running = false; await polled(); await new Promise(r => setTimeout(r, 20));
	// 点所有按钮
	const btns = []; (function walk(n) { if (n instanceof Node) { if (n.tag == 'button') btns.push(n); n.children.forEach(walk); } })(el);
	for (const b of btns) await b.attrs.click();
	console.log('选项', opts.length, '个，按钮', btns.length, '个');
	console.log(opts.find(o => o.name == '_raw').cfgvalue('main'));
	console.log('ALL OK');
})().catch(e => { console.error('ERR', e); process.exit(1); });
