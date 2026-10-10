'use strict';
'require view';
'require fs';
'require ui';

/*
 * luci-app-cftunnel 前端
 * 标签页：首页 / 账户配置 / 系统设置 / 隧道列表 / 运行日志
 */

var BIN = '/usr/libexec/cftunnel';
var DASH_TOKEN = 'https://dash.cloudflare.com/profile/api-tokens';
var DASH_ZT = 'https://one.dash.cloudflare.com/';

function run(args) {
	return fs.exec(BIN, args).then(function(r) {
		try { return JSON.parse(r.stdout); }
		catch (e) { throw new Error(((r.stderr || '') + (r.stdout || '')).trim() || '后端无输出'); }
	});
}

function cfErr(j) {
	return ((j && j.errors) || []).map(function(e) { return (e.code ? e.code + ' ' : '') + e.message; }).join('；');
}

function api(method, path, body) {
	return run(['api', method, path].concat(body ? [JSON.stringify(body)] : [])).then(function(j) {
		if (!j || !j.success) throw new Error(cfErr(j) || 'Cloudflare 返回失败');
		return j;
	});
}

function notify(msg, type) { ui.addNotification(null, E('p', msg), type || 'info'); }
function fail(e) { ui.hideModal(); notify(e.message || String(e), 'danger'); }
function wait(msg) { ui.showModal(null, [E('p', { 'class': 'spinning' }, msg)]); }
function btn(label, cls, fn, title) {
	return E('button', { 'class': 'btn cbi-button ' + (cls || ''), 'title': title || '', 'click': ui.createHandlerFn(this, fn) }, label);
}
function link(href, text) { return E('a', { 'href': href, 'target': '_blank', 'rel': 'noreferrer' }, text); }

function dur(sec) {
	sec = Math.max(0, sec | 0);
	var d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
	var p = function(n) { return (n < 10 ? '0' : '') + n; };
	return (d ? d + ' 天 ' : '') + p(h) + ':' + p(m) + ':' + p(s);
}

function fmtDate(iso) {
	if (!iso) return '';
	var d = new Date(iso);
	if (isNaN(d)) return iso;
	var p = function(n) { return (n < 10 ? '0' : '') + n; };
	return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

var CF_STATUS = {
	healthy:  ['健康', 'ok',   'Cloudflare 已收到这条隧道的连接，访问正常'],
	degraded: ['降级', 'warn', '部分连接断开，通常几分钟内自动恢复'],
	down:     ['离线', 'bad',  '隧道没有任何连接。若本机显示「运行中」，看运行日志排查'],
	inactive: ['未运行', 'off', '隧道从未连接过，点「连接」在本机启动它']
};

var CSS = [
	'.cft-tabs{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid rgba(128,128,128,.25);margin:10px 0 16px}',
	'.cft-tabs a{padding:8px 16px;cursor:pointer;border-bottom:2px solid transparent;text-decoration:none;color:inherit;opacity:.75}',
	'.cft-tabs a.on{border-bottom-color:#2563eb;color:#2563eb;opacity:1;font-weight:600}',
	'.cft-card{border:1px solid rgba(128,128,128,.22);border-radius:10px;padding:16px 18px;margin-bottom:14px}',
	'.cft-card h4{margin:0 0 10px;font-size:15px;display:flex;justify-content:space-between;align-items:center}',
	'.cft-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-top:12px}',
	'.cft-stat{border:1px solid rgba(128,128,128,.18);border-radius:8px;padding:10px 12px}',
	'.cft-stat small{display:block;opacity:.65;margin-bottom:4px}',
	'.cft-stat b{font-family:monospace;font-size:16px}',
	'.cft-big{font-size:20px;font-weight:700;display:flex;align-items:center;gap:10px}',
	'.cft-dot{width:12px;height:12px;border-radius:50%;display:inline-block}',
	'.cft-badge{font-size:12px;padding:1px 8px;border-radius:10px;margin-left:6px;font-weight:normal;white-space:nowrap}',
	'.cft-ok{background:#dcfce7;color:#15803d}.cft-warn{background:#fef3c7;color:#b45309}',
	'.cft-bad{background:#fee2e2;color:#b91c1c}.cft-off{background:#e5e7eb;color:#4b5563}.cft-info{background:#dbeafe;color:#1d4ed8}',
	'.cft-hint{font-size:12px;opacity:.7;margin-top:4px;line-height:1.6}',
	'.cft-help{margin:8px 0 12px;font-size:13px;line-height:1.8}',
	'.cft-help summary{cursor:pointer;color:#2563eb}',
	'.cft-help ol,.cft-help ul{margin:6px 0 6px 20px}',
	'.cft-steps li{margin:4px 0}',
	'.cft-steps .done{color:#15803d}',
	'.cft-t{border:1px solid rgba(128,128,128,.22);border-radius:10px;padding:12px 16px;margin-bottom:10px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between}',
	'.cft-t .name{font-size:16px;font-weight:600}',
	'.cft-t .meta{font-size:12px;opacity:.7;margin-top:4px}',
	'.cft-t .hosts{font-size:13px;margin-top:6px}',
	'.cft-t .ops .btn{margin-left:4px}',
	'.cft-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
	'.cft-field{margin-bottom:14px}',
	'.cft-field>label{display:block;font-weight:600;margin-bottom:4px}',
	'.cft-field input[type=text],.cft-field input[type=password],.cft-field select{width:100%;max-width:520px}',
	'.cft-log{white-space:pre-wrap;font-size:12px;max-height:520px;overflow:auto;background:rgba(0,0,0,.04);padding:10px;border-radius:6px}'
].join('\n');

function badge(text, kind, title) { return E('span', { 'class': 'cft-badge cft-' + kind, 'title': title || '' }, text); }

function help(title, items) {
	return E('details', { 'class': 'cft-help' }, [E('summary', '❓ ' + (title || '使用说明'))].concat(items));
}

function field(label, input, hint) {
	return E('div', { 'class': 'cft-field' }, [E('label', label), input, hint ? E('div', { 'class': 'cft-hint' }, hint) : '']);
}

function card(title, body, right) {
	return E('div', { 'class': 'cft-card' }, [E('h4', [E('span', title), right || ''])].concat(body));
}

return view.extend({
	load: function() {
		return run(['status']).catch(function(e) { return { error: e.message, tunnels: [] }; });
	},

	render: function(st) {
		this.st = st; this.tunnels = null; this.zones = []; this.tab = this.tab || 'home';
		this.content = E('div');
		this.nav = E('div', { 'class': 'cft-tabs' });
		var m = E('div', { 'class': 'cbi-map' }, [
			E('style', CSS),
			E('h2', 'Cloudflare 隧道'),
			E('div', { 'class': 'cbi-map-descr' }, '不用公网 IP、不用开端口，把内网服务（NAS、路由后台、Home Assistant 等）通过 Cloudflare 安全地发布到你自己的域名。'),
			this.nav, this.content
		]);
		this.draw();
		this.loadRemote().then(L.bind(this.draw, this)).catch(L.bind(function(e) { this.remoteErr = e.message; this.draw(); }, this));
		// 每 10 秒刷新本机状态；只在不含输入框的页面重绘，免得冲掉正在填写的内容
		window.setInterval(L.bind(function() {
			if (['home', 'tunnels'].indexOf(this.tab) < 0 || document.querySelector('.modal')) return;
			run(['status']).then(L.bind(function(s) { this.st = s; this.draw(); }, this)).catch(function() {});
		}, this), 10000);
		return m;
	},

	/* ---------- 数据 ---------- */
	loadRemote: function() {
		var st = this.st;
		if (!st.has_token || !st.account_id) { this.tunnels = []; return Promise.resolve(); }
		var acc = st.account_id;
		return Promise.all([
			api('GET', '/accounts/' + acc + '/cfd_tunnel?is_deleted=false&per_page=100'),
			api('GET', '/zones?per_page=50&status=active')
		]).then(L.bind(function(r) {
			this.remoteErr = null;
			this.tunnels = r[0].result || [];
			this.zones = r[1].result || [];
			return Promise.all(this.tunnels.map(function(t) {
				return api('GET', '/accounts/' + acc + '/cfd_tunnel/' + t.id + '/configurations')
					.then(function(c) { t.ingress = ((c.result || {}).config || {}).ingress || []; })
					.catch(function() { t.ingress = []; });
			}));
		}, this));
	},

	refresh: function() {
		return run(['status']).then(L.bind(function(st) {
			this.st = st;
			return this.loadRemote();
		}, this)).then(L.bind(this.draw, this)).catch(L.bind(function(e) { this.remoteErr = e.message; this.draw(); }, this));
	},

	/* ---------- 框架 ---------- */
	draw: function() {
		var tabs = [['home', '首页'], ['account', '账户配置'], ['system', '系统设置'], ['tunnels', '隧道列表'], ['logs', '运行日志']];
		this.nav.innerHTML = '';
		tabs.forEach(L.bind(function(t) {
			this.nav.appendChild(E('a', { 'class': this.tab == t[0] ? 'on' : '', 'click': L.bind(function() { this.tab = t[0]; this.draw(); }, this) }, t[1]));
		}, this));
		var f = { home: this.drawHome, account: this.drawAccount, system: this.drawSystem, tunnels: this.drawTunnels, logs: this.drawLogs }[this.tab];
		this.content.innerHTML = '';
		[].concat(f.call(this, this.st || {})).forEach(L.bind(function(n) { this.content.appendChild(n); }, this));
		this.watchInstall();
	},

	go: function(tab) { this.tab = tab; this.draw(); window.scrollTo(0, 0); },

	watchInstall: function() {
		if (!this.st.installing || this.poll) return;
		this.poll = window.setInterval(L.bind(function() {
			run(['status']).then(L.bind(function(s) {
				this.st = s;
				if (!s.installing) {
					window.clearInterval(this.poll); this.poll = null;
					var ok = /完成/.test(s.install_log || '');
					notify(ok ? '更新完成：' + s.version : '没有更新成功，详情见首页的下载日志', ok ? 'info' : 'warning');
				}
				if (this.tab == 'home') this.draw();
			}, this));
		}, this), 3000);
	},

	/* ---------- 首页 ---------- */
	drawHome: function(st) {
		var local = st.tunnels || [];
		var running = local.filter(function(t) { return t.running; });
		var enabled = local.filter(function(t) { return t.enabled; });
		var state, color, sub;
		if (!st.version) { state = '程序缺失'; color = '#dc2626'; sub = 'cloudflared 不可用，点下方「重新下载」'; }
		else if (running.length) { state = '运行中'; color = '#16a34a'; sub = running.length + ' 个隧道的 cloudflared 进程正在运行'; }
		else if (enabled.length) { state = '启动中'; color = '#d97706'; sub = '已启用的隧道还在启动，或启动失败（看运行日志）'; }
		else { state = '未运行'; color = '#9ca3af'; sub = '还没有启用的隧道，按下面的「快速上手」操作'; }

		var now = +st.uptime || 0;
		var grid = E('div', { 'class': 'cft-grid' }, [
			E('div', { 'class': 'cft-stat' }, [E('small', '系统架构'), E('b', st.arch || '未知')]),
			E('div', { 'class': 'cft-stat' }, [E('small', '运行中 / 已启用隧道'), E('b', running.length + ' / ' + enabled.length)]),
			E('div', { 'class': 'cft-stat' }, [E('small', '连接协议'), E('b', ({ http2: 'HTTP/2', quic: 'QUIC', auto: '自动' })[st.protocol || 'http2'] || st.protocol)]),
			E('div', { 'class': 'cft-stat' }, [E('small', '开机自动连接'), E('b', st.autostart == '0' ? '关' : '开')])
		]);
		running.forEach(function(t) {
			grid.appendChild(E('div', { 'class': 'cft-stat' }, [E('small', (t.name || t.id) + ' · PID ' + (t.pid || '-')),
				E('b', t.started != null ? '已运行 ' + dur(now - t.started) : '运行中')]));
		});

		var statusCard = card('服务状态', [
			E('div', { 'class': 'cft-big' }, [E('span', { 'class': 'cft-dot', 'style': 'background:' + color }), state]),
			E('div', { 'class': 'cft-hint' }, sub),
			grid
		], E('span', [
			btn('刷新', '', L.bind(this.refresh, this)),
			btn('重启服务', 'cbi-button-apply', L.bind(function() { return run(['restart']).then(L.bind(this.refresh, this)).catch(fail); }, this), '重启所有已启用隧道的 cloudflared 进程'),
			enabled.length ? btn('全部断开', 'cbi-button-reset', L.bind(function() {
				if (!confirm('断开本机所有隧道？Cloudflare 上的隧道和域名配置不受影响，之后可在隧道列表里重新连接。')) return;
				return run(['stopall']).then(L.bind(this.refresh, this)).catch(fail);
			}, this)) : ''
		]));

		var bin = card('cloudflared 程序', [
			E('div', st.version ? E('span', { 'style': 'color:#16a34a' }, '✔ ' + st.version) : E('span', { 'style': 'color:#dc2626' }, '✘ 没有可用的 cloudflared')),
			E('div', { 'class': 'cft-hint' }, '插件已自带一份 arm64 的 cloudflared，正常不需要下载。「检查更新」会从 GitHub 拉最新版：先走「系统设置」里的下载代理，失败再直连；连续 20 秒没速度就自动放弃，原来的版本保持不变。'),
			E('div', { 'style': 'margin-top:8px' }, st.installing
				? [E('em', '下载中…（约 38MB）'), ' ', btn('停止', 'cbi-button-reset', L.bind(this.cancel, this))]
				: [btn(st.version ? '检查更新' : '重新下载', 'cbi-button-action', L.bind(this.install, this))]),
			st.install_log ? E('pre', { 'class': 'cft-log', 'style': 'margin-top:8px' }, st.install_log) : ''
		]);

		var hasTok = !!st.has_token, hasAcc = !!st.account_id;
		var nT = (this.tunnels || []).length + local.filter(function(t) { return /^manual_/.test(t.id); }).length;
		var hasHost = (this.tunnels || []).some(function(t) { return (t.ingress || []).some(function(r) { return r.hostname; }); });
		var step = function(done, html) { return E('li', { 'class': done ? 'done' : '' }, [done ? '✔ ' : '○ '].concat(html)); };
		var guide = card('快速上手', [
			E('ol', { 'class': 'cft-steps' }, [
				step(true, ['准备一个已经接入 Cloudflare 的域名（域名的 NS 改到 Cloudflare，状态显示「有效」）。']),
				step(hasTok, ['在 ', link(DASH_TOKEN, 'Cloudflare API 令牌页面'), ' 创建令牌（权限见「账户配置」里的说明），粘贴到 ',
					E('a', { 'href': '#', 'click': L.bind(function(ev) { ev.preventDefault(); this.go('account'); }, this) }, '账户配置'), ' 并保存。']),
				step(hasTok && hasAcc, ['保存后会自动选好账户（有多个账户时可手动切换）。']),
				step(nT > 0, ['到 ', E('a', { 'href': '#', 'click': L.bind(function(ev) { ev.preventDefault(); this.go('tunnels'); }, this) }, '隧道列表'), ' 点「新建隧道」，起个名字，会自动在本机连接。']),
				step(hasHost, ['点隧道的「公网地址」，填 子域名 → 内网地址（如 nas → http://192.168.2.10:5000），保存后自动加好 DNS，一分钟内就能用 https 访问。'])
			]),
			E('div', { 'class': 'cft-hint' }, '不想给 API 令牌？也可以在 Cloudflare Zero Trust 网页里建好隧道，把 eyJ 开头的隧道令牌粘到「隧道列表 → 用令牌添加」。')
		]);
		return [statusCard, guide, bin];
	},

	cancel: function() {
		return run(['cancel']).then(L.bind(function() { return run(['status']); }, this)).then(L.bind(function(s) {
			this.st = s;
			if (this.poll) { window.clearInterval(this.poll); this.poll = null; }
			notify('已停止下载'); this.draw();
		}, this)).catch(fail);
	},

	install: function() {
		return run(['install']).then(L.bind(function(r) {
			if (!r.success) throw new Error(cfErr(r));
			this.st.installing = true; this.draw();
		}, this)).catch(fail);
	},

	/* ---------- 账户配置 ---------- */
	drawAccount: function(st) {
		var tok = E('input', { 'type': 'password', 'class': 'cbi-input-text', 'autocomplete': 'off',
			'placeholder': st.has_token ? '已保存（不修改就留空）' : '粘贴 API 令牌，40 位左右的字母数字' });
		var eye = E('button', { 'class': 'btn cbi-button', 'title': '显示 / 隐藏', 'click': function(ev) {
			ev.preventDefault(); tok.type = tok.type == 'password' ? 'text' : 'password';
		} }, '👁');
		var acc = E('select', { 'class': 'cbi-input-select' });
		var fill = function(list, cur) {
			acc.innerHTML = '';
			if (!list || !list.length) { acc.appendChild(E('option', { 'value': cur || '' }, cur ? '当前：' + cur : '测试或保存令牌后自动读取')); return; }
			list.forEach(function(a) { acc.appendChild(E('option', { 'value': a.id, 'selected': a.id == cur ? '' : null }, a.name + '（' + a.id.slice(0, 8) + '…）')); });
		};
		fill(this.accounts, st.account_id);
		var result = E('div', { 'class': 'cft-hint', 'style': 'opacity:1' });

		var test = L.bind(function() {
			var t = tok.value.trim();
			if (!t && !st.has_token) return notify('先粘贴 API 令牌', 'warning');
			wait('正在用这个令牌访问 Cloudflare…');
			return run(t ? ['verify', t] : ['verify']).then(L.bind(function(r) {
				ui.hideModal();
				if (r.success === false) throw new Error(cfErr(r));
				var a = r.accounts || {}, z = r.zones || {};
				if (!a.success) throw new Error('令牌无效：' + (cfErr(a) || '未知错误'));
				var accs = a.result || [], zs = (z && z.success) ? (z.result || []) : null;
				this.accounts = accs; fill(accs, st.account_id || (accs[0] || {}).id);
				result.innerHTML = '';
				result.appendChild(E('div', [
					accs.length ? badge('账户 ✔ ' + accs.length + ' 个', 'ok') : badge('读不到账户：缺「账户设置 · 读取」', 'bad'), ' ',
					zs == null ? badge('读不到域名：缺「区域 · 读取」', 'bad') : zs.length ? badge('域名 ✔ ' + zs.map(function(x) { return x.name; }).join('、'), 'ok') : badge('账户下没有有效域名', 'warn')
				]));
				result.appendChild(E('div', { 'style': 'margin-top:4px' }, '「Cloudflare Tunnel · 编辑」和「DNS · 编辑」只有真正建隧道、加解析时才能验证；缺的话那一步会报 10000 / 9109 之类的权限错误。'));
				return accs;
			}, this)).catch(fail);
		}, this);

		var save = L.bind(function() {
			var t = tok.value.trim();
			if (!t && !st.has_token) return notify('先粘贴 API 令牌', 'warning');
			wait('验证并保存…');
			return run(t ? ['verify', t] : ['verify']).then(L.bind(function(r) {
				var a = (r && r.accounts) || {};
				if (!a.success) throw new Error('令牌无效：' + (cfErr(a) || cfErr(r) || '未知错误'));
				var list = a.result || [];
				if (!list.length) throw new Error('令牌能用，但读不到账户，需要「账户 · 账户设置 · 读取」权限');
				this.accounts = list;
				var cur = list.some(function(x) { return x.id == acc.value; }) ? acc.value : list[0].id;
				var args = ['setcfg', 'account_id', cur];
				if (t) args.push('api_token', t);
				return run(args);
			}, this)).then(L.bind(function() {
				ui.hideModal(); notify('已保存，令牌有效。下一步到「隧道列表」新建隧道。');
				return this.refresh();
			}, this)).catch(fail);
		}, this);

		var clear = L.bind(function() {
			if (!confirm('清除保存的 API 令牌和账户？已经在本机运行的隧道不受影响。')) return;
			return run(['setcfg', 'api_token', '', 'account_id', '']).then(L.bind(function() { this.accounts = null; this.tunnels = []; return this.refresh(); }, this)).catch(fail);
		}, this);

		return [card('Cloudflare API 令牌', [
			help('怎么创建 API 令牌？', [E('ol', [
				E('li', ['打开 ', link(DASH_TOKEN, 'dash.cloudflare.com → 我的个人资料 → API 令牌'), '，点「创建令牌」。']),
				E('li', '拉到最下面选「创建自定义令牌」→「开始使用」，名称随便填，如 istore-tunnel。'),
				E('li', ['「权限」里加 4 行：', E('ul', [
					E('li', [E('b', '账户 · Cloudflare Tunnel · 编辑'), ' —— 建、删、配置隧道']),
					E('li', [E('b', '账户 · 账户设置 · 读取'), ' —— 读取账户 ID']),
					E('li', [E('b', '区域 · DNS · 编辑'), ' —— 自动添加 / 删除 CNAME 解析']),
					E('li', [E('b', '区域 · 区域 · 读取'), ' —— 列出你的域名'])
				])]),
				E('li', '「账户资源」选你的账户；「区域资源」选「所有区域」或指定域名。'),
				E('li', '继续 → 创建令牌，把显示的令牌复制粘贴到下面（只显示一次，丢了重新建一个）。')
			]), E('div', '令牌只保存在路由器 /etc/config/cftunnel 里，只用来调用 Cloudflare 官方 API。')]),
			field('API 令牌', E('div', { 'class': 'cft-row' }, [tok, eye]), st.has_token ? '已保存一个令牌。要换新的就粘贴进来，再点「保存配置」。' : '粘贴后先点「测试令牌」看看权限够不够，再保存。'),
			field('账户', acc, '一个 Cloudflare 登录名下可能有多个账户（比如被别人邀请进的团队），选你的域名所在的那个。只有一个时自动选好。'),
			result,
			E('div', { 'class': 'cft-row', 'style': 'margin-top:10px' }, [
				btn('测试令牌', '', test, '只检查，不保存'),
				btn('保存配置', 'cbi-button-save', save),
				st.has_token ? btn('清除令牌', 'cbi-button-remove', clear) : ''
			])
		])];
	},

	/* ---------- 系统设置 ---------- */
	drawSystem: function(st) {
		var auto = E('input', { 'type': 'checkbox', 'checked': st.autostart == '0' ? null : '' });
		var proto = E('select', { 'class': 'cbi-input-select' }, [
			['http2', 'HTTP/2（推荐，国内更稳）'], ['quic', 'QUIC（UDP，速度快但常被限速）'], ['auto', '自动（先 QUIC，不通再 HTTP/2）']
		].map(function(o) { return E('option', { 'value': o[0], 'selected': (st.protocol || 'http2') == o[0] ? '' : null }, o[1]); }));
		var ipv = E('select', { 'class': 'cbi-input-select' }, [
			['auto', '自动（推荐）'], ['4', '仅 IPv4'], ['6', '仅 IPv6']
		].map(function(o) { return E('option', { 'value': o[0], 'selected': (st.ip_version || 'auto') == o[0] ? '' : null }, o[1]); }));
		var px = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': st.proxy || '', 'placeholder': '例如 https://9797.cc.cd/ ，留空表示直连 GitHub' });

		var save = L.bind(function() {
			wait('保存中…');
			return run(['setcfg', 'autostart', auto.checked ? '1' : '0', 'protocol', proto.value, 'ip_version', ipv.value, 'proxy', px.value.trim()])
				.then(L.bind(function() { ui.hideModal(); notify('已保存，正在运行的隧道已按新设置重启'); return this.refresh(); }, this)).catch(fail);
		}, this);

		return [card('连接设置', [
			help('这些选项怎么选？', [E('ul', [
				E('li', [E('b', '开机自动连接：'), '路由器重启后，自动重新连接所有「已连接」状态的隧道。关掉后重启路由器需要手动点「连接」。']),
				E('li', [E('b', '连接协议：'), 'cloudflared 到 Cloudflare 的传输方式。QUIC 走 UDP 443，国内运营商经常限速或丢包，导致隧道频繁断开，所以默认 HTTP/2（TCP 443）。海外或网络很好时可以试 QUIC。']),
				E('li', [E('b', 'IP 版本：'), '连接 Cloudflare 边缘节点用 IPv4 还是 IPv6。没有 IPv6 或 IPv6 不稳定时选「仅 IPv4」；只有 IPv6 出口时选「仅 IPv6」。']),
				E('li', [E('b', '下载代理：'), '只在首页「检查更新」下载 cloudflared 时使用，格式是在 GitHub 链接前加的前缀（如 https://9797.cc.cd/），对隧道本身没有影响。'])
			])]),
			field(E('span', [auto, ' 开机自动连接']), '', '路由器重启后自动连接上次已连接的隧道'),
			field('连接协议', proto, '改了以后正在运行的隧道会自动重启生效'),
			field('IP 版本', ipv, '连接 Cloudflare 时使用的 IP 协议'),
			field('下载代理', px, '只用于下载 / 更新 cloudflared 程序；留空则直连 GitHub'),
			E('div', { 'class': 'cft-row' }, [btn('保存设置', 'cbi-button-save', save)])
		])];
	},

	/* ---------- 隧道列表 ---------- */
	drawTunnels: function(st) {
		var local = {}, self = this;
		(st.tunnels || []).forEach(function(t) { local[t.id] = t; });
		var apiOK = st.has_token && st.account_id;
		var list = E('div');
		var now = +st.uptime || 0;

		var tunnelCard = function(t, lt, tokenOnly) {
			var cs = tokenOnly ? null : (CF_STATUS[t.status] || [t.status, 'off', '']);
			var hosts = (t.ingress || []).filter(function(r) { return r.hostname; });
			var localB = lt.enabled
				? (lt.running ? badge('本机运行中', 'ok', 'PID ' + (lt.pid || '-')) : badge('本机启动中', 'warn', '正在启动或启动失败，可看运行日志'))
				: badge('本机未连接', 'off', '点「连接」在本机启动');
			var meta = [];
			if (t.created_at) meta.push('创建于 ' + fmtDate(t.created_at));
			if (!tokenOnly) meta.push((t.connections || []).length + ' 条连接');
			if (lt.running && lt.started != null) meta.push('已运行 ' + dur(now - lt.started));
			var ops = [];
			if (lt.enabled) ops.push(btn('断开', 'cbi-button-reset', L.bind(tokenOnly ? self.stopLocal : self.stopT, self, t), '停止本机的 cloudflared 进程，Cloudflare 上的配置保留'));
			else ops.push(btn('连接', 'cbi-button-apply', L.bind(tokenOnly ? self.startLocal : self.startT, self, t), '在本机启动 cloudflared 连接这条隧道'));
			if (!tokenOnly) ops.push(btn('公网地址', 'cbi-button-edit', L.bind(self.editRoutes, self, t), '设置 子域名 → 内网服务'));
			ops.push(btn('删除', 'cbi-button-remove', L.bind(tokenOnly ? self.delLocal : self.delT, self, t)));
			return E('div', { 'class': 'cft-t' }, [
				E('div', { 'style': 'flex:1;min-width:260px' }, [
					E('div', [E('span', { 'class': 'name' }, t.name || t.id), cs ? badge(cs[0], cs[1], cs[2]) : badge('仅令牌', 'info', '用隧道令牌添加，公网地址请在 Cloudflare Zero Trust 网页里配置'), localB]),
					E('div', { 'class': 'meta' }, meta.join(' · ')),
					tokenOnly ? '' : E('div', { 'class': 'hosts' }, hosts.length ? hosts.map(function(r) {
						return E('div', ['🌐 ', link('https://' + r.hostname, r.hostname), ' → ', E('code', r.service)]);
					}) : E('em', { 'style': 'opacity:.7' }, '还没有公网地址，点「公网地址」添加'))
				]),
				E('div', { 'class': 'ops' }, ops)
			]);
		};

		if (apiOK) {
			if (this.tunnels == null) list.appendChild(E('p', { 'class': 'spinning' }, '正在读取 Cloudflare 上的隧道…'));
			else if (this.remoteErr) list.appendChild(E('div', { 'class': 'alert-message warning' }, '读取失败：' + this.remoteErr + '（检查令牌权限或网络）'));
			else if (!this.tunnels.length) list.appendChild(E('p', { 'style': 'opacity:.7' }, '这个账户下还没有隧道，点右上角「新建隧道」。'));
			(this.tunnels || []).forEach(function(t) { list.appendChild(tunnelCard(t, local[t.id] || {}, false)); });
		} else {
			list.appendChild(E('div', { 'class': 'alert-message notice' }, ['还没有配置 API 令牌，无法列出和新建隧道。',
				E('a', { 'href': '#', 'click': function(ev) { ev.preventDefault(); self.go('account'); } }, '去账户配置 →'),
				' 或者用右上角「用令牌添加」。']));
		}
		var known = {};
		(this.tunnels || []).forEach(function(t) { known[t.id] = 1; });
		(st.tunnels || []).filter(function(t) { return !apiOK || !known[t.id]; }).forEach(function(t) {
			list.appendChild(tunnelCard({ id: t.id, name: t.name }, t, true));
		});

		return [card('隧道', [
			help('「连接」「公网地址」分别是什么意思？', [E('ul', [
				E('li', [E('b', '隧道：'), 'Cloudflare 和本路由器之间的一条加密通道。一条隧道可以挂很多个域名，一般建一条就够。']),
				E('li', [E('b', '连接 / 断开：'), '在本路由器上启动 / 停止 cloudflared 进程。断开后通过这条隧道的所有域名都访问不了，但配置还在。']),
				E('li', [E('b', '公网地址：'), '「子域名.你的域名」对应哪个内网服务，比如 nas.example.com → http://192.168.2.10:5000。保存时自动添加 CNAME 解析（橙色云朵代理）。']),
				E('li', [E('b', 'Cloudflare 状态：'), '健康 = 正常；降级 = 部分连接断开；离线 = 没有连接；未运行 = 从没连过。']),
				E('li', [E('b', '仅令牌：'), '用 eyJ 开头的隧道令牌添加的隧道，域名要在 Cloudflare Zero Trust 网页里配置。'])
			])]),
			list
		], E('span', [
			btn('刷新', '', L.bind(this.refresh, this)),
			apiOK ? btn('新建隧道', 'cbi-button-add', L.bind(this.newTunnel, this)) : '',
			btn('用令牌添加', '', L.bind(this.addByToken, this))
		]))];
	},

	newTunnel: function() {
		var st = this.st, self = this;
		var name = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'placeholder': '例如 home 或 n1' });
		ui.showModal('新建隧道', [
			field('隧道名称', name, '只能用英文字母、数字、- 和 _，账户内不能重名。建好后会自动在本机连接。'),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, '取消'), ' ',
				E('button', { 'class': 'btn cbi-button-positive', 'click': ui.createHandlerFn(this, function() {
					var n = name.value.trim();
					if (!/^[A-Za-z0-9_-]{1,60}$/.test(n)) return notify('名称只能用字母、数字、- 和 _', 'warning');
					wait('在 Cloudflare 上创建隧道…');
					return api('POST', '/accounts/' + st.account_id + '/cfd_tunnel', { name: n, config_src: 'cloudflare' })
						.then(function(r) { return run(['enable', r.result.id, n]).then(function() { return r.result; }); })
						.then(function(t) { ui.hideModal(); notify('隧道「' + n + '」已创建并在本机连接。下一步：点它的「公网地址」绑定域名。'); return self.refresh(); })
						.catch(fail);
				}) }, '创建并连接')
			])
		]);
		name.focus();
	},

	addByToken: function() {
		var self = this;
		var name = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'placeholder': '随便起个名字，方便自己认' });
		var tok = E('textarea', { 'class': 'cbi-input-textarea', 'rows': 4, 'style': 'width:100%', 'placeholder': 'eyJhIjoi… 开头的一长串' });
		ui.showModal('用隧道令牌添加', [
			help('隧道令牌在哪里找？', [E('ol', [
				E('li', ['打开 ', link(DASH_ZT, 'Cloudflare Zero Trust'), ' → 网络 → 隧道（Networks → Tunnels）。']),
				E('li', '新建或打开一条 Cloudflared 隧道，在「安装并运行连接器」那一步，随便选一个系统。'),
				E('li', '页面上的命令里 --token 或 install 后面那一长串（eyJ 开头）就是隧道令牌，复制粘贴到下面。'),
				E('li', '公网地址（Public Hostname）也在那个网页里添加。')
			])]),
			field('名称', name),
			field('隧道令牌', tok, '也可以直接粘贴整条安装命令，会自动提取 eyJ 开头的部分。'),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, '取消'), ' ',
				E('button', { 'class': 'btn cbi-button-positive', 'click': ui.createHandlerFn(this, function() {
					var m = (tok.value.match(/eyJ[A-Za-z0-9+/=_-]{40,}/) || [])[0], tid = '';
					if (!m) return notify('没找到 eyJ 开头的令牌', 'warning');
					try { tid = JSON.parse(atob(m.replace(/-/g, '+').replace(/_/g, '/'))).t || ''; } catch (e) {}
					if (!tid) return notify('令牌格式不对，请完整复制', 'warning');
					return run(['add_token', name.value.trim() || 'tunnel', m, tid])
						.then(function() { ui.hideModal(); notify('已添加并连接'); return self.refresh(); }).catch(fail);
				}) }, '添加并连接')
			])
		]);
	},

	startT: function(t) {
		if (!this.st.version) return notify('cloudflared 不可用，先到首页重新下载', 'warning');
		wait('启动中…');
		return run(['enable', t.id, t.name]).then(function(r) { if (!r.success) throw new Error(cfErr(r)); })
			.then(L.bind(function() { ui.hideModal(); notify('已连接，Cloudflare 状态一般 10~30 秒后变成「健康」'); return this.refresh(); }, this)).catch(fail);
	},
	stopT: function(t) { return run(['disable', t.id]).then(L.bind(this.refresh, this)).catch(fail); },
	startLocal: function(t) { return run(['save_enable', t.id]).then(L.bind(this.refresh, this)).catch(fail); },
	stopLocal: function(t) { return run(['disable', t.id]).then(L.bind(this.refresh, this)).catch(fail); },
	delLocal: function(t) {
		if (!confirm('从本机删除「' + (t.name || t.id) + '」？只删除本机记录，Cloudflare 上的隧道请到 Zero Trust 网页删除。')) return;
		return run(['remove', t.id]).then(L.bind(this.refresh, this)).catch(fail);
	},

	delT: function(t) {
		if (!confirm('删除隧道「' + t.name + '」？\n\n会同时：停止本机进程、删除 Cloudflare 上的这条隧道、删除它绑定域名的 DNS 解析。此操作不可恢复。')) return;
		var acc = this.st.account_id, self = this;
		wait('删除中…');
		var hosts = (t.ingress || []).filter(function(r) { return r.hostname; }).map(function(r) { return r.hostname; });
		return run(['remove', t.id])
			.then(function() { return Promise.all(hosts.map(function(h) { return self.dnsDelete(h, t.id).catch(function() {}); })); })
			.then(function() { return api('DELETE', '/accounts/' + acc + '/cfd_tunnel/' + t.id + '/connections').catch(function() {}); })
			.then(function() { return api('DELETE', '/accounts/' + acc + '/cfd_tunnel/' + t.id); })
			.then(function() { ui.hideModal(); notify('已删除'); return self.refresh(); })
			.catch(fail);
	},

	/* ---------- DNS ---------- */
	zoneOf: function(host) {
		var best = null;
		(this.zones || []).forEach(function(z) {
			if ((host == z.name || host.endsWith('.' + z.name)) && (!best || z.name.length > best.name.length)) best = z;
		});
		return best;
	},

	dnsUpsert: function(host, tid) {
		var z = this.zoneOf(host);
		if (!z) return Promise.reject(new Error(host + ' 不在这个账户的域名里'));
		var body = { type: 'CNAME', name: host, content: tid + '.cfargotunnel.com', proxied: true, comment: 'luci-app-cftunnel' };
		return api('GET', '/zones/' + z.id + '/dns_records?name=' + encodeURIComponent(host)).then(function(r) {
			var ex = r.result || [];
			if (ex.some(function(x) { return x.type == 'CNAME' && x.content == body.content; })) return;
			var other = ex.filter(function(x) { return ['A', 'AAAA', 'CNAME'].indexOf(x.type) >= 0; });
			if (other.length) {
				if (!confirm(host + ' 已经有一条 ' + other[0].type + ' 解析（指向 ' + other[0].content + '）。\n改成指向这个隧道吗？原来的解析会被覆盖。')) throw new Error('已取消：' + host);
				return api('PUT', '/zones/' + z.id + '/dns_records/' + other[0].id, body);
			}
			return api('POST', '/zones/' + z.id + '/dns_records', body);
		});
	},

	dnsDelete: function(host, tid) {
		var z = this.zoneOf(host);
		if (!z) return Promise.resolve();
		return api('GET', '/zones/' + z.id + '/dns_records?type=CNAME&name=' + encodeURIComponent(host)).then(function(r) {
			return Promise.all((r.result || []).filter(function(x) { return x.content == tid + '.cfargotunnel.com'; })
				.map(function(x) { return api('DELETE', '/zones/' + z.id + '/dns_records/' + x.id); }));
		});
	},

	/* ---------- 公网地址 ---------- */
	editRoutes: function(t) {
		var self = this, zones = this.zones || [];
		if (!zones.length) return notify('这个账户下没有可用域名（或令牌缺少「区域 · 区域 · 读取」权限）', 'warning');
		var list = E('div');
		var addRow = function(r) {
			r = r || {};
			var z = r.hostname ? self.zoneOf(r.hostname) : zones[0];
			var sub = r.hostname && z ? r.hostname.slice(0, Math.max(0, r.hostname.length - z.name.length - 1)) : '';
			var subI = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'style': 'width:120px', 'value': sub, 'placeholder': '子域名，如 nas' });
			var zS = E('select', { 'class': 'cbi-input-select', 'style': 'width:auto' }, zones.map(function(x) {
				return E('option', { 'value': x.name, 'selected': z && x.name == z.name ? '' : null }, x.name);
			}));
			var svc = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'style': 'width:230px', 'value': r.service || '', 'placeholder': 'http://192.168.2.10:5000' });
			var tls = E('input', { 'type': 'checkbox', 'checked': r.originRequest && r.originRequest.noTLSVerify ? '' : null });
			var row = E('div', { 'style': 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px' }, [
				subI, '.', zS, ' → ', svc,
				E('label', { 'title': '内网服务是 https 且用的是自签证书时勾上，否则会 502' }, [tls, ' 忽略证书']),
				E('button', { 'class': 'btn cbi-button cbi-button-remove', 'click': function() { row.remove(); } }, '删除')
			]);
			row.get = function() {
				var s = subI.value.trim(), host = (s ? s + '.' : '') + zS.value, sv = svc.value.trim();
				if (!sv) return null;
				if (!/^(https?|tcp|ssh|rdp|unix|http_status):/.test(sv)) sv = 'http://' + sv;
				var o = { hostname: host, service: sv };
				if (tls.checked) o.originRequest = { noTLSVerify: true };
				return o;
			};
			list.appendChild(row);
		};
		var old = (t.ingress || []).filter(function(r) { return r.hostname; });
		old.forEach(addRow);
		if (!old.length) addRow();

		ui.showModal('公网地址 · ' + t.name, [
			help('怎么填？', [E('ul', [
				E('li', [E('b', '子域名：'), '想要的访问地址前缀。填 nas、选 example.com，访问地址就是 https://nas.example.com 。留空表示用根域名本身。']),
				E('li', [E('b', '内网服务：'), '从路由器能访问到的地址，带协议和端口。例：路由后台 http://192.168.2.254:80，NAS http://192.168.2.10:5000，飞牛 http://192.168.2.234:5666 。不写协议默认 http://。']),
				E('li', [E('b', '忽略证书：'), '内网服务本身是 https（自签证书）时勾上，例如 https://192.168.2.10:5001 。']),
				E('li', '外网访问时由 Cloudflare 自动提供 https 证书，内网服务不需要开端口、不需要证书。'),
				E('li', '保存后自动添加 CNAME 解析；如果这个域名已经有别的解析，会先问你是否覆盖。删除一行会同时删掉它的解析。')
			])]),
			list,
			E('button', { 'class': 'btn cbi-button cbi-button-add', 'click': function() { addRow(); } }, '+ 添加一条'),
			E('div', { 'class': 'right', 'style': 'margin-top:12px' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, '取消'), ' ',
				E('button', { 'class': 'btn cbi-button-positive', 'click': ui.createHandlerFn(this, function() {
					var rules = Array.prototype.map.call(list.children, function(r) { return r.get(); }).filter(Boolean);
					var seen = {};
					for (var i = 0; i < rules.length; i++) {
						if (seen[rules[i].hostname]) return notify('重复的域名 ' + rules[i].hostname, 'warning');
						seen[rules[i].hostname] = 1;
					}
					var removed = old.map(function(r) { return r.hostname; }).filter(function(h) { return !seen[h]; });
					var acc = self.st.account_id;
					wait('保存中…');
					return api('PUT', '/accounts/' + acc + '/cfd_tunnel/' + t.id + '/configurations',
						{ config: { ingress: rules.concat([{ service: 'http_status:404' }]) } })
						.then(function() { return rules.reduce(function(p, r) { return p.then(function() { return self.dnsUpsert(r.hostname, t.id); }); }, Promise.resolve()); })
						.then(function() { return Promise.all(removed.map(function(h) { return self.dnsDelete(h, t.id).catch(function() {}); })); })
						.then(function() { ui.hideModal(); notify('已保存，DNS 生效通常不到一分钟'); return self.refresh(); })
						.catch(function(e) { fail(e); return self.refresh(); });
				}) }, '保存')
			])
		]);
	},

	/* ---------- 运行日志 ---------- */
	drawLogs: function() {
		var pre = E('pre', { 'class': 'cft-log' }, '读取中…');
		var n = E('select', { 'class': 'cbi-input-select', 'style': 'width:auto' }, ['100', '300', '1000'].map(function(x) { return E('option', { 'value': x }, '最近 ' + x + ' 行'); }));
		var autoCb = E('input', { 'type': 'checkbox' });
		var self = this;
		var load = function() {
			return run(['logs', n.value]).then(function(r) {
				pre.textContent = r.log || '（没有日志。隧道连接后，cloudflared 的输出会出现在这里）';
				pre.scrollTop = pre.scrollHeight;
			}).catch(function(e) { pre.textContent = e.message; });
		};
		n.addEventListener('change', load);
		if (this.logTimer) window.clearInterval(this.logTimer);
		this.logTimer = window.setInterval(function() { if (self.tab != 'logs') { window.clearInterval(self.logTimer); return; } if (autoCb.checked) load(); }, 5000);
		load();
		return [card('cloudflared 运行日志', [
			help('日志里常见的提示', [E('ul', [
				E('li', [E('code', 'Registered tunnel connection'), ' —— 连接成功，正常会有 4 条（连到不同机房）。']),
				E('li', [E('code', 'failed to dial to edge with quic'), ' —— QUIC 被限制，到「系统设置」改成 HTTP/2。']),
				E('li', [E('code', 'Unauthorized: Invalid tunnel secret'), ' —— 隧道令牌失效或隧道已被删除，删掉重新添加。']),
				E('li', [E('code', 'dial tcp ... connection refused'), ' —— 内网服务地址或端口填错了，或者服务没开。']),
				E('li', [E('code', 'context deadline exceeded / i/o timeout'), ' —— 网络连不上 Cloudflare，检查路由器自己的上网。'])
			])]),
			E('div', { 'class': 'cft-row', 'style': 'margin-bottom:8px' }, [n, btn('刷新', '', load), E('label', [autoCb, ' 每 5 秒自动刷新'])]),
			pre
		])];
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
