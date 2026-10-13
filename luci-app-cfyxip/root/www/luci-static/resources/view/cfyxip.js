'use strict';
'require view';
'require form';
'require fs';
'require ui';
'require poll';

/*
 * luci-app-cfyxip：Cloudflare 优选 IP
 */

var BIN = '/usr/libexec/cfyxip';

function runJSON(args) {
	return fs.exec(BIN, args).then(function(r) {
		try { return JSON.parse(r.stdout); }
		catch (e) { throw new Error(((r.stderr || '') + (r.stdout || '')).trim() || '后端无输出'); }
	});
}
function notify(msg, type) { ui.addNotification(null, E('p', msg), type || 'info'); }
function fmtTime(ts) {
	if (!ts) return '—';
	var d = new Date(ts * 1000), p = function(n) { return (n < 10 ? '0' : '') + n; };
	return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function hint(t) { return E('div', { 'style': 'color:#888;font-size:90%' }, t); }

return view.extend({
	load: function() {
		return Promise.all([
			L.resolveDefault(runJSON(['status']), {}),
			L.resolveDefault(runJSON(['result']), { results: [] }),
			L.resolveDefault(runJSON(['colos']), [])
		]);
	},

	renderStatus: function(s) {
		var st = s.status || {}, rows = [];
		var row = function(k, v, h) {
			return E('tr', { 'class': 'tr' }, [E('td', { 'class': 'td left', 'style': 'width:8em' }, k),
				E('td', { 'class': 'td left' }, [v, h ? hint(h) : ''])]);
		};
		var state;
		if (s.running) {
			var pct = st.total ? Math.floor(st.done * 100 / st.total) : 0;
			state = E('span', {}, [E('b', { 'style': 'color:#1565c0' }, '● 扫描中　'), (st.phase || '准备中') + '　' + st.done + '/' + st.total + '（' + pct + '%），已通过 ' + st.found + ' 个',
				E('div', { 'style': 'background:#e3f2fd;height:6px;border-radius:3px;margin-top:4px;max-width:420px' },
					E('div', { 'style': 'background:#1565c0;height:6px;border-radius:3px;width:' + pct + '%' }))]);
		} else if (st.state == 'error') {
			state = E('span', { 'style': 'color:#c62828' }, '✕ 上次扫描失败：' + (st.message || ''));
		} else if (st.state == 'done') {
			state = E('span', {}, [E('b', { 'style': 'color:#2e7d32' }, '✓ 空闲'), st.message ? E('span', { 'style': 'color:#e65100' }, '　' + st.message) : '']);
		} else {
			state = E('span', { 'style': 'color:#888' }, '还没扫描过，点下面「立即扫描」试试');
		}
		rows.push(row('状态', state));
		rows.push(row('上次结果', s.count ? (fmtTime(s.last) + '，' + s.count + ' 个可用 IP') : '—'));
		rows.push(row('定时扫描', s.cron ? E('span', { 'style': 'color:#2e7d32' }, '已开启') : E('span', { 'style': 'color:#888' }, '未开启'),
			'在下面「定时任务」里设置，保存并应用后生效。'));
		rows.push(row('程序版本', s.version || '—'));
		return E('table', { 'class': 'table' }, rows);
	},

	renderResults: function(res) {
		var list = (res && res.results) || [];
		if (!list.length)
			return E('p', { 'style': 'color:#888' }, '暂无结果。');
		var th = function(t) { return E('th', { 'class': 'th left' }, t); };
		var rows = [E('tr', { 'class': 'tr table-titles' }, [th('#'), th('IP:端口'), th('落地机房'), th('国家'), th('TCP 延迟'), th('HTTPS 耗时'), th('下载速度'), th('复验')])];
		list.forEach(function(r, i) {
			var td = function(t) { return E('td', { 'class': 'td left' }, t); };
			rows.push(E('tr', { 'class': 'tr' }, [td(i + 1), td(E('code', {}, r.ip + ':' + r.port)), td(r.colo + (r.city ? '（' + r.city + '）' : '')),
				td(r.country + ' ' + r.cc), td(Math.round(r.latency) + ' ms'), td(Math.round(r.http_ms) + ' ms'),
				td(r.speed ? r.speed.toFixed(2) + ' MB/s' : '未测'), td(r.checks ? r.checks + ' 次通过' : '—')]));
		});
		return E('table', { 'class': 'table' }, rows);
	},

	render: function(data) {
		var self = this, s0 = data[0], res = data[1], colos = data[2] || [];
		var desc = E('div', { 'class': 'cbi-map-descr' }, ['在路由器上扫描 Cloudflare 的 IP，挑出在你家网络下延迟低、速度快、而且真的能用的，生成 ',
				E('code', {}, 'IP:端口#备注'), ' 格式的 xyip.txt，可定时运行并推送到 GitHub，搭 Cloudflare 节点（Workers / Pages / 隧道）时直接引用。', E('br'),
				'和普通测速工具的区别：每个 IP 都会用真实 HTTPS 请求验证（校验证书 + 读取 /cdn-cgi/trace 拿到真实落地机房），测速后再复验几次，偶尔能通或被干扰的 IP 一律淘汰。']);
		var m = new form.Map('cfyxip', '', '');
		var s = m.section(form.NamedSection, 'main', 'cfyxip');
		s.anonymous = true;
		s.tab('scan', '扫描设置');
		s.tab('place', '落地国家');
		s.tab('speed', '测速与验证');
		s.tab('cron', '定时任务');
		s.tab('gh', 'GitHub 推送');
		s.tab('help', '使用说明');
		var o;

		o = s.taboption('scan', form.Value, 'count', '要几个优选 IP',
			'最终写进 xyip.txt 的数量，按速度从快到慢排。节点里一般 5～20 个就够。默认 10。');
		o.datatype = 'range(1,200)'; o.placeholder = '10';

		o = s.taboption('scan', form.Value, 'sample', '抽样 IP 数量',
			'从 Cloudflare 官方 IP 段（约 6000 个 /24 网段）里随机抽多少个 IP 测试。越多越容易找到好 IP，但越慢。N1 上 4000 个大约 1～3 分钟。默认 4000。');
		o.datatype = 'range(100,100000)'; o.placeholder = '4000';

		o = s.taboption('scan', form.Value, 'threads', '线程数（并发）',
			'同时测多少个 IP 的 TCP 延迟。越大越快，但太大可能让路由器或光猫吃不消、结果反而不准。N1 建议 100～300。默认 200。');
		o.datatype = 'range(1,1000)'; o.placeholder = '200';

		o = s.taboption('scan', form.Value, 'max_latency', '延迟上限（毫秒）',
			'TCP 平均延迟超过这个值的 IP 直接淘汰。电信/联通到美国西海岸一般 150～200ms，到香港/日本 40～120ms。默认 300。');
		o.datatype = 'range(20,2000)'; o.placeholder = '300';

		o = s.taboption('scan', form.Value, 'tcp_tries', 'TCP 测试次数',
			'每个 IP 连几次，必须全部连通才算过（等于要求丢包率 0%）。默认 3。');
		o.datatype = 'range(1,10)'; o.placeholder = '3';

		o = s.taboption('scan', form.Value, 'ports', '端口',
			'测哪些端口，多个用空格或逗号分隔。Cloudflare 支持的 HTTPS 端口：443、2053、2083、2087、2096、8443。每个端口单独验证，结果里写成 IP:端口。默认 443。');
		o.placeholder = '443';

		o = s.taboption('scan', form.Flag, 'keep_old', '上次的好 IP 也参与',
			'把上一次的结果放进本次候选一起测，好 IP 能留下来，结果更稳定。');
		o.default = '1';

		o = s.taboption('scan', form.DynamicList, 'extra_ips', '额外 IP / 网段（可选）',
			'除了官方 IP 段，再加一些你自己收集的 IP 或网段（如 104.16.0.0/24、某些反代 IP）。只支持 IPv4。');
		o.placeholder = '1.2.3.4 或 104.16.0.0/24';

		o = s.taboption('place', form.MultiValue, 'countries', '落地国家/地区',
			'只要落地在这些国家/地区的 IP，不选 = 不限。落地看的是这个 IP 实际连到的 Cloudflare 机房（从 /cdn-cgi/trace 读出来的，不是查 IP 库猜的）。' +
			'注意：Cloudflare 是任播，你能连到哪些机房由运营商线路决定，国内电信/联通大多落在美国（LAX 洛杉矶、SJC 圣何塞），移动常见香港/新加坡/日本；选了连不到的国家会扫不出结果。');
		o.widget = 'select';
		o.size = 12;
		colos.forEach(function(c) { o.value(c.Code, c.Name + ' ' + c.Code + '（' + c.Colos.length + ' 个机房）'); });

		o = s.taboption('place', form.DynamicList, 'colos', '指定机房（可选）',
			'更精确地只要某几个机房，填三字码，如 LAX、SJC、HKG、NRT、SIN。不填 = 按上面的国家筛选。两个都填时要同时满足。');
		o.placeholder = 'LAX';

		o = s.taboption('speed', form.Flag, 'speed_test', '下载测速',
			'对通过验证的 IP 实际下载一段数据测速度。很多 IP 延迟很低但几乎跑不动（比如晚高峰的香港节点），不测速就会被选进来。建议开。');
		o.default = '1';

		o = s.taboption('speed', form.Value, 'min_speed', '最低速度（MB/s）',
			'低于这个速度的淘汰。1 MB/s ≈ 8 Mbps。看你的宽带：100M 宽带填 3～5，500M 宽带可填 10。默认 1。');
		o.datatype = 'ufloat'; o.placeholder = '1'; o.depends('speed_test', '1');

		o = s.taboption('speed', form.Value, 'speed_mb', '测速下载量（MB）',
			'每个 IP 最多下载多少数据。默认 50。');
		o.datatype = 'range(1,500)'; o.placeholder = '50'; o.depends('speed_test', '1');

		o = s.taboption('speed', form.Value, 'speed_seconds', '每个 IP 测速时长（秒）',
			'每个 IP 最多测几秒，到时间就按已下载的量算速度。默认 8。');
		o.datatype = 'range(3,60)'; o.placeholder = '8'; o.depends('speed_test', '1');

		o = s.taboption('speed', form.Value, 'speed_host', '测速域名',
			'用哪个域名的 /__down 接口测速，必须是 Cloudflare 官方测速站或兼容的接口。一般不用改。');
		o.placeholder = 'speed.cloudflare.com'; o.depends('speed_test', '1');

		o = s.taboption('speed', form.Value, 'validate_host', '验证域名',
			'验证 IP 能不能用时，把这个域名强制解析到被测 IP、正常校验证书去访问。<b>强烈建议填你节点自己的域名</b>（Workers 自定义域、Pages 域名或隧道的公网主机名），' +
			'这样验证的就是「这个 IP 连你的节点能不能用」，被运营商按 SNI 干扰的 IP 也会被筛掉。必须是已开启 Cloudflare 代理（橙色云朵）的域名。默认 speed.cloudflare.com。');
		o.placeholder = 'speed.cloudflare.com';

		o = s.taboption('speed', form.Value, 'validate_path', '验证路径',
			'默认 /cdn-cgi/trace（任何走 Cloudflare 的域名都有，要求返回 200 和机房信息）。改成别的路径时，只要求不是 5xx 且有 cf-ray 响应头。');
		o.placeholder = '/cdn-cgi/trace';

		o = s.taboption('speed', form.Value, 'recheck', '复验次数',
			'测速通过后，再隔一会儿验证几次，必须每次都通过、而且落地机房不变，才算稳定可用。0 = 不复验。默认 3。');
		o.datatype = 'range(0,10)'; o.placeholder = '3';

		o = s.taboption('speed', form.Value, 'remark', '备注格式',
			'xyip.txt 每行 # 后面的备注（节点名）。可用变量：{colo} 机房、{cc} 国家代码、{country} 国家、{city} 城市、{speed} 速度、{latency} 延迟、{ip}、{port}。' +
			'默认 “{colo} {speed}MB/s {latency}ms”，例如 104.17.69.180:443#LAX 16.88MB/s 167ms。');
		o.placeholder = '{colo} {speed}MB/s {latency}ms';

		o = s.taboption('cron', form.Flag, 'cron_enable', '启用定时扫描',
			'到点自动扫描一次，扫完自动更新 xyip.txt，开了 GitHub 推送的话也会自动推送。');

		o = s.taboption('cron', form.MultiValue, 'cron_hours', '每天几点',
			'可以多选，例如 5 点和 17 点各跑一次。建议避开你上网的高峰，扫描时会占一些带宽。');
		o.widget = 'select'; o.size = 8;
		for (var h = 0; h < 24; h++) o.value(String(h), (h < 10 ? '0' : '') + h + ' 点');
		o.default = '5';
		o.depends('cron_enable', '1');

		o = s.taboption('cron', form.Value, 'cron_minute', '第几分钟',
			'0～59。默认 0，即整点。');
		o.datatype = 'range(0,59)'; o.placeholder = '0';
		o.depends('cron_enable', '1');

		o = s.taboption('gh', form.Flag, 'push', '扫描后推送到 GitHub',
			'每次扫描成功后，把 xyip.txt 推送到你的 GitHub 仓库（内容没变就不推）。节点里引用 raw 地址即可自动用上最新的优选 IP。');

		o = s.taboption('gh', form.Value, 'gh_repo', '仓库',
			'格式：用户名/仓库名，例如 zknjjjx/cf-preferred-ip。建议用公开仓库，否则节点读不到 raw 文件。');
		o.placeholder = '用户名/仓库名';

		o = s.taboption('gh', form.Value, 'gh_branch', '分支', '默认 main。');
		o.placeholder = 'main';

		o = s.taboption('gh', form.Value, 'gh_path', '文件路径', '仓库里的文件名，默认 xyip.txt（可以带目录，如 cf/xyip.txt）。');
		o.placeholder = 'xyip.txt';

		o = s.taboption('gh', form.Value, 'gh_token', 'GitHub 令牌（可留空）',
			'留空 = 复用「AI 运维助手」里填过的 GitHub 令牌。单独填的话：GitHub → Settings → Developer settings → Fine-grained tokens，只选这个仓库，权限 Contents 设为 Read and write。');
		o.password = true; o.placeholder = 'github_pat_...';

		o = s.taboption('gh', form.DummyValue, '_raw', '引用地址');
		o.rawhtml = true;
		o.cfgvalue = function(sid) {
			var repo = this.map.data.get('cfyxip', sid, 'gh_repo'), br = this.map.data.get('cfyxip', sid, 'gh_branch') || 'main',
				p = this.map.data.get('cfyxip', sid, 'gh_path') || 'xyip.txt';
			if (!repo) return '<span style="color:#888">填好仓库并保存后显示</span>';
			var u = 'https://raw.githubusercontent.com/' + repo + '/' + br + '/' + p.replace(/^\//, '');
			return '<code>' + u + '</code><div style="color:#888;font-size:90%">在 edgetunnel 等节点的 ADDAPI / 优选 IP 订阅里填这个地址。国内拉不动 raw 时可在前面加 https://gh-proxy.com/ 。</div>';
		};

		o = s.taboption('help', form.DummyValue, '_help');
		o.rawhtml = true;
		o.cfgvalue = function() {
			return '<ol style="line-height:1.9">' +
				'<li>先直接点上面的<b>立即扫描</b>用默认设置跑一次，看看你的网络能连到哪些机房、速度多少。</li>' +
				'<li>「测速与验证」里把<b>验证域名</b>改成你节点自己的域名（最重要的一步，保证选出来的 IP 连你的节点真的能用）。</li>' +
				'<li>按需要在「落地国家」里选国家/机房，「扫描设置」里调延迟上限、数量。</li>' +
				'<li>「GitHub 推送」里填仓库并勾选推送；「定时任务」里勾选启用、选时间。保存并应用。</li>' +
				'<li>节点里引用「GitHub 推送」页显示的 raw 地址。</li>' +
				'</ol><p>扫描步骤：抽样 → TCP 延迟（多次全通）→ HTTPS 验证并识别落地机房 → 按国家/机房过滤 → 下载测速 → 复验 → 取最快的 N 个。</p>' +
				'<p style="color:#888">结果文件：/etc/cfyxip/xyip.txt（也可以点「查看 xyip.txt」）。扫描时会跑满一部分带宽，建议放在凌晨。</p>';
		};

		return m.render().then(function(formEl) {
			var statusBox = E('div', {}, self.renderStatus(s0));
			var resBox = E('div', {}, self.renderResults(res));
			var logBox = E('textarea', { 'readonly': 'readonly', 'wrap': 'off', 'rows': 16, 'style': 'width:100%;font-family:monospace;font-size:12px' }, '');
			var replace = function(el, c) { while (el.firstChild) el.removeChild(el.firstChild); el.appendChild(c); };
			var wasRunning = !!s0.running;
			var refresh = function() {
				return Promise.all([L.resolveDefault(runJSON(['status']), null), fs.exec(BIN, ['log', '300'])]).then(function(r) {
					if (r[0]) {
						replace(statusBox, self.renderStatus(r[0]));
						if (wasRunning && !r[0].running)
							L.resolveDefault(runJSON(['result']), null).then(function(x) { if (x) replace(resBox, self.renderResults(x)); });
						wasRunning = !!r[0].running;
					}
					var t = ((r[1] && r[1].stdout) || '').trim();
					var atEnd = logBox.scrollTop + logBox.clientHeight >= logBox.scrollHeight - 20;
					logBox.value = t || '（暂无日志）';
					if (atEnd) logBox.scrollTop = logBox.scrollHeight;
				});
			};
			var btn = function(label, cls, fn, title) {
				return E('button', { 'class': 'btn cbi-button ' + cls, 'title': title || '', 'click': ui.createHandlerFn(self, fn) }, label);
			};
			var buttons = E('div', { 'style': 'margin:.5em 0 1em' }, [
				btn('立即扫描', 'cbi-button-action', function() {
					return runJSON(['start']).then(function(r) { if (!r.ok) notify(r.msg, 'warning'); wasRunning = true; return refresh(); });
				}, '用已保存的设置马上扫描一次（改了设置请先「保存并应用」）'), ' ',
				btn('停止', 'cbi-button-reset', function() { return runJSON(['stop']).then(refresh); }), ' ',
				btn('推送到 GitHub', 'cbi-button-apply', function() {
					return runJSON(['push']).then(function(r) { notify(r.ok ? '推送完成（内容没变时不会产生新提交）' : ('推送失败：' + r.msg), r.ok ? 'info' : 'danger'); return refresh(); });
				}, '把当前的 xyip.txt 推送到 GitHub'), ' ',
				btn('查看 xyip.txt', 'cbi-button-neutral', function() {
					return fs.exec(BIN, ['txt']).then(function(r) {
						ui.showModal('xyip.txt', [E('textarea', { 'readonly': 'readonly', 'rows': 14, 'style': 'width:100%;font-family:monospace' }, (r.stdout || '').trim() || '（还没有结果）'),
							E('div', { 'class': 'right' }, E('button', { 'class': 'btn', 'click': ui.hideModal }, '关闭'))]);
					});
				})
			]);
			poll.add(refresh, 3);
			refresh();
			return E('div', {}, [
				E('h2', {}, 'Cloudflare优选IP'), desc,
				E('div', { 'class': 'cbi-section' }, [E('h3', {}, '运行状态'), statusBox, buttons]),
				E('div', { 'class': 'cbi-section' }, [E('h3', {}, '本次优选结果'), resBox]),
				formEl,
				E('div', { 'class': 'cbi-section' }, [E('h3', {}, '扫描日志'), logBox])
			]);
		});
	}
});
