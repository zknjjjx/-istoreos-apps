'use strict';
'require view';
'require form';
'require fs';
'require ui';
'require poll';

/*
 * luci-app-opsagent：飞书 + DeepSeek 的 AI 运维助手
 */

var BIN = '/usr/libexec/opsagent';

function run(args) {
	return fs.exec(BIN, args).then(function(r) {
		try { return JSON.parse(r.stdout); }
		catch (e) { throw new Error(((r.stderr || '') + (r.stdout || '')).trim() || '后端无输出'); }
	});
}

function notify(msg, type) { ui.addNotification(null, E('p', msg), type || 'info'); }
function link(href, text) { return E('a', { 'href': href, 'target': '_blank', 'rel': 'noreferrer' }, text); }

function ago(ts, now) {
	if (!ts) return '—';
	var s = Math.max(0, (now || Date.now() / 1000) - ts) | 0;
	if (s < 60) return s + ' 秒前';
	if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
	if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
	return Math.floor(s / 86400) + ' 天前';
}

var STATE = {
	online:     ['● 在线', '#2e7d32', '已和飞书保持长连接，可以在飞书里给机器人发消息了'],
	connecting: ['● 连接中', '#f9a825', '正在连接飞书，一般几秒钟'],
	starting:   ['● 启动中', '#f9a825', '程序刚启动'],
	error:      ['● 连接失败', '#c62828', '看下面的错误信息；多半是 App ID / App Secret 不对，或飞书应用还没发布']
};

return view.extend({
	load: function() {
		return L.resolveDefault(run(['status']), {});
	},

	renderStatus: function(st) {
		var a = st.agent || {}, rows = [];
		var row = function(k, v, hint) {
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left', 'style': 'width:9em' }, k),
				E('td', { 'class': 'td left' }, [v, hint ? E('div', { 'style': 'color:#888;font-size:90%' }, hint) : ''])
			]);
		};
		var running;
		if (!st.python)
			running = E('span', { 'style': 'color:#c62828' }, '缺少 python3，请在「系统 → 软件包」安装 python3 和 python3-websockets');
		else if (!st.websockets)
			running = E('span', { 'style': 'color:#c62828' }, '缺少 python3-websockets，请在「系统 → 软件包」安装');
		else if (st.running) {
			var s = STATE[a.state] || [a.state || '未知', '#888', ''];
			running = E('span', {}, [E('b', { 'style': 'color:' + s[1] }, s[0]),
				E('span', { 'style': 'color:#888' }, '　PID ' + st.pid + '，内存 ' + Math.round((st.rss_kb || 0) / 1024) + ' MB'),
				E('div', { 'style': 'color:#888;font-size:90%' }, s[2])]);
		} else
			running = E('span', { 'style': 'color:#888' }, st.enabled == '1' ? '未运行（检查下面三项密钥是否都填了，并看运行日志）' : '未启用（勾选「启用」并保存应用）');
		rows.push(row('运行状态', running));
		if (a.error) rows.push(row('最近错误', E('span', { 'style': 'color:#c62828' }, a.error)));
		rows.push(row('主人', st.owner_open_id
			? E('span', {}, [(st.owner_name || '') + ' ', E('code', {}, st.owner_open_id)])
			: E('span', { 'style': 'color:#888' }, '尚未绑定'),
			'第一个在飞书里给机器人发消息的人会被绑定为主人，之后机器人只听这个人的。换人请点「解除绑定」。'));
		rows.push(row('最近消息', ago(a.last_event, st.now)));
		return E('table', { 'class': 'table' }, rows);
	},

	render: function(st) {
		var self = this;
		var m = new form.Map('opsagent', 'AI 运维助手',
			E('span', {}, ['在飞书里用大白话管理这台路由器：查状态、看日志、重启服务。大脑用 DeepSeek，飞书走长连接，不需要公网 IP。',
				E('br'), '安全规则：只读命令直接执行；会改动系统的命令先发到飞书问你，回复「确认」才执行；刷机、清盘等高危命令一律拒绝；密码和令牌在发给 AI 前会被抹掉。']));

		var s = m.section(form.NamedSection, 'main', 'opsagent');
		s.tab('basic', '基本设置');
		s.tab('ai', '大模型');
		s.tab('nas', 'NAS');
		s.tab('gh', 'GitHub');
		s.tab('cf', 'Cloudflare');
		s.tab('web', '联网搜索');
		s.tab('adv', '高级');
		s.tab('help', '使用说明');

		var o;
		o = s.taboption('basic', form.Flag, 'enabled', '启用',
			'打开后开机自动运行，并保持和飞书的连接。三项密钥都填好才会真正启动。');
		o.rmempty = false;

		o = s.taboption('basic', form.Value, 'app_id', '飞书 App ID',
			E('span', {}, ['飞书开放平台 → 你的应用 → 「凭证与基础信息」里的 App ID，形如 cli_a1b2c3…。 ',
				link('https://open.feishu.cn/app', '打开飞书开发者后台')]));
		o.placeholder = 'cli_xxxxxxxxxxxxxxxx';
		o.validate = function(id, v) { return (!v || /^cli_[0-9a-z]+$/.test(v)) ? true : 'App ID 应该以 cli_ 开头'; };

		o = s.taboption('basic', form.Value, 'app_secret', '飞书 App Secret',
			'同一页面的 App Secret。只保存在路由器上，不会发给 AI。');
		o.password = true;

		o = s.taboption('ai', form.Value, 'api_key', 'API Key',
			E('span', {}, ['DeepSeek 开放平台 → API keys 里创建的密钥，形如 sk-…。 ', link('https://platform.deepseek.com/api_keys', '打开 DeepSeek 控制台')]));
		o.password = true;

		o = s.taboption('ai', form.Value, 'model', '模型',
			'默认 deepseek-flash：便宜、快，日常运维足够。想要更强的推理可以改成 deepseek-v4-pro（更贵、更慢）。');
		o.value('deepseek-flash', 'deepseek-flash（推荐）');
		o.value('deepseek-v4-pro', 'deepseek-v4-pro');
		o.default = 'deepseek-flash';

		o = s.taboption('ai', form.Value, 'base_url', '接口地址',
			'OpenAI 兼容接口的地址，一般不用改。换成其他兼容服务（如通义、Kimi 的 OpenAI 兼容地址）时，模型名也要跟着改。');
		o.placeholder = 'https://api.deepseek.com';
		o.default = 'https://api.deepseek.com';

		o = s.taboption('nas', form.Value, 'nas_host', 'NAS 地址',
			'填了就启用 NAS 工具：AI 会通过 SSH 登录这台 NAS 执行命令（装环境、写代码、构建、跑 docker 等）。留空则不连 NAS。例：192.168.2.234');
		o.datatype = 'host';
		o.placeholder = '192.168.2.234';

		o = s.taboption('nas', form.Value, 'nas_user', 'SSH 用户',
			'登录 NAS 用的用户。用 root 才能装软件、管 docker；只想让它在自己目录里折腾就建个普通用户。');
		o.placeholder = 'root';

		o = s.taboption('nas', form.Value, 'nas_port', 'SSH 端口', 'NAS 的 SSH 端口，飞牛默认 22。');
		o.datatype = 'port';
		o.placeholder = '22';

		o = s.taboption('nas', form.Value, 'nas_key', '私钥文件',
			'路由器上的 SSH 私钥（dropbear 格式）。没有的话在路由器上执行 <code>dropbearkey -t ed25519 -f /etc/opsagent/nas_key</code> 生成，再把输出的公钥那行加到 NAS 对应用户的 <code>~/.ssh/authorized_keys</code>。');
		o.placeholder = '/etc/opsagent/nas_key';

		o = s.taboption('nas', form.Flag, 'nas_auto', '改动免确认',
			'开：在 NAS 上装包、改文件、重启容器等直接执行，适合把 NAS 当开发机让 AI 长时间干活。关：和路由器一样，改动要你回复「确认」。无论开关，格式化、清盘、删整个存储卷都会先问你。');
		o.default = '1';

		o = s.taboption('gh', form.Value, 'github_token', 'GitHub 令牌',
			'填了就让 AI 用你的 GitHub 账号：查 Actions 构建、发 Release、建仓库，并在 NAS 上 git clone / push（凭据自动带上，不会写进 NAS 的文件）。删除类操作会先问你。<br>' +
			'创建：GitHub → Settings → Developer settings → Personal access tokens → <b>Fine-grained tokens</b> → Generate new token；Repository access 选 All repositories（或只选要给它的仓库）；' +
			'Repository permissions 开 <b>Contents、Actions、Workflows、Pull requests、Issues、Administration</b> 为 Read and write（Administration 用来建仓库，不想给可不开）。有效期按你习惯设，过期后在这里换新的。');
		o.password = true;
		o.placeholder = 'github_pat_...';

		o = s.taboption('cf', form.Flag, 'cf_enable', '启用 Cloudflare 工具',
			'让 AI 管理你的 Cloudflare 隧道和域名 DNS（查看、新建直接做；修改、删除先问你）。');
		o.default = '1';

		o = s.taboption('cf', form.Value, 'cf_token', 'API 令牌（可留空）',
			'留空 = 直接用「Cloudflare 隧道」插件里已保存的令牌和账户，不用重复填。想单独给 AI 一个权限更小的令牌就填这里，需要：账户·Cloudflare Tunnel·编辑、区域·DNS·编辑、区域·区域·读取。');
		o.password = true;

		o = s.taboption('cf', form.Value, 'cf_account', '账户 ID（可留空）',
			'留空 = 用隧道插件里的账户 ID。');

		o = s.taboption('web', form.Flag, 'search_enable', '启用联网搜索',
			'让 AI 能上网搜索、打开网页：问天气、新闻、价格、软件版本这类实时信息时，它会先搜再答，并附上来源链接。只读，不会改动任何东西。');
		o.default = '1';

		o = s.taboption('web', form.ListValue, 'search_engine', '搜索引擎',
			'<b>必应</b>：免费、不用注册，国内直连（cn.bing.com），一般够用。<br><b>Tavily</b>：专为 AI 设计的搜索接口，结果更干净还带摘要；需在 tavily.com 注册拿 API Key（每月 1000 次免费）。Tavily 出错时会自动退回必应。');
		o.value('bing', '必应（免费，默认）');
		o.value('tavily', 'Tavily（需 API Key）');
		o.default = 'bing';
		o.depends('search_enable', '1');

		o = s.taboption('web', form.Value, 'tavily_key', 'Tavily API Key',
			'只有选 Tavily 时才需要。登录 app.tavily.com → API Keys 复制，以 tvly- 开头。');
		o.password = true;
		o.placeholder = 'tvly-...';
		o.depends('search_engine', 'tavily');

		o = s.taboption('adv', form.Value, 'confirm_timeout', '确认有效期（秒）',
			'改动类命令发给你确认后，多久不回复就作废。默认 600 秒（10 分钟）。');
		o.datatype = 'range(60,3600)';
		o.placeholder = '600';

		o = s.taboption('adv', form.Value, 'max_steps', '单次最多执行步数',
			'AI 回答一个问题时最多连续执行几条命令，到了就停下等你说「继续」。查问题 8 步就够；让它在 NAS 上做开发建议 30 以上。默认 30。');
		o.datatype = 'range(1,100)';
		o.placeholder = '30';

		o = s.taboption('adv', form.Value, 'history', '记住的对话条数',
			'AI 能记住最近多少条消息（含命令输出）。越多越懂上下文，但每次花的 token 越多。默认 30；在飞书里发「新对话」可随时清空。');
		o.datatype = 'range(4,100)';
		o.placeholder = '30';

		o = s.taboption('adv', form.Value, 'agh_user', 'AdGuard Home 用户名',
			'可选。填了以后 AI 能直接查 AdGuard 的拦截统计和查询日志（AdGuard 的接口需要登录）。就是登录 AdGuard 管理页（:3000）用的账号。');
		o.placeholder = 'admin';

		o = s.taboption('adv', form.Value, 'agh_pass', 'AdGuard Home 密码',
			'只在路由器本机调用 AdGuard 接口时使用，命令输出发给 AI 前会被抹掉。');
		o.password = true;

		o = s.taboption('help', form.DummyValue, '_help');
		o.rawhtml = true;
		o.cfgvalue = function() {
			return '<ol style="line-height:1.9">' +
				'<li>在飞书开放平台建好「企业自建应用」，添加<b>机器人</b>能力，开通权限 <code>im:message.p2p_msg:readonly</code>、<code>im:message:send_as_bot</code>、<code>im:message</code>，发布版本。</li>' +
				'<li>在本页「基本设置」填 App ID、App Secret，「大模型」填 DeepSeek API Key，勾选启用，点「保存并应用」。</li>' +
				'<li>等上面状态变成<b style="color:#2e7d32">在线</b>（可以点「测试连接」检查）。</li>' +
				'<li>回飞书开放平台 → 事件与回调 → 事件配置 → 订阅方式选<b>使用长连接接收事件</b>并保存（路由器必须在线才能保存成功）。</li>' +
				'<li>同页「添加事件」，搜索并添加<b>接收消息</b>（im.message.receive_v1）。</li>' +
				'<li>版本管理与发布 → 创建新版本 → 发布。</li>' +
				'<li>手机打开飞书，搜索你的机器人名字，发一句「你好」：第一个发消息的人会被绑定为主人。</li>' +
				'</ol><p>在飞书里可以发：<b>状态</b>（直接看负载/内存/温度）、<b>新对话</b>（清空上下文）、<b>帮助</b>。其余直接用大白话问。</p>' +
				'<p style="color:#888">费用参考：DeepSeek 按 token 计费，日常问几次状态一天花不到几分钱。</p>';
		};

		return m.render().then(function(formEl) {
			var statusBox = E('div', {}, self.renderStatus(st));
			var logBox = E('textarea', { 'readonly': 'readonly', 'wrap': 'off', 'rows': 18,
				'style': 'width:100%;font-family:monospace;font-size:12px' }, '');

			var refresh = function() {
				return L.resolveDefault(run(['status']), null).then(function(s) {
					if (s) { dom_replace(statusBox, self.renderStatus(s)); }
				});
			};
			var refreshLogs = function() {
				return fs.exec(BIN, ['logs', '200']).then(function(r) {
					logBox.value = (r.stdout || '').trim() || '（暂无日志）';
					logBox.scrollTop = logBox.scrollHeight;
				});
			};
			var dom_replace = function(el, child) { while (el.firstChild) el.removeChild(el.firstChild); el.appendChild(child); };

			var btn = function(label, cls, fn, title) {
				return E('button', { 'class': 'btn cbi-button ' + cls, 'title': title, 'click': ui.createHandlerFn(self, fn) }, label);
			};

			var buttons = E('div', { 'style': 'margin:.5em 0 1em' }, [
				btn('测试连接', 'cbi-button-action', function() {
					ui.showModal('测试连接', [E('p', { 'class': 'spinning' }, '正在测试飞书和大模型接口，最多一分钟…')]);
					return fs.exec(BIN, ['test']).then(function(r) {
						var j = {};
						try { j = JSON.parse(r.stdout); } catch (e) { j = { '输出': (r.stdout || '') + (r.stderr || '') }; }
						var line = function(k, v) {
							var ok = /^ok/.test(v || '');
							return E('p', {}, [E('b', {}, k + '：'), E('span', { 'style': 'color:' + (ok ? '#2e7d32' : '#c62828') }, v || '—')]);
						};
						ui.showModal('测试结果', [
							line('飞书', j.feishu), line('大模型', j.llm), line('websockets 模块', j.websockets), j.nas ? line('NAS', j.nas) : '', j.github ? line('GitHub', j.github) : '', j.cloudflare ? line('Cloudflare', j.cloudflare) : '', j.search ? line('联网搜索', j.search) : '',
							E('div', { 'class': 'right' }, E('button', { 'class': 'btn', 'click': ui.hideModal }, '关闭'))
						]);
					}).catch(function(e) { ui.hideModal(); notify(e.message, 'danger'); });
				}, '用已保存的密钥检查飞书和 DeepSeek 是否都能连上（先保存再测）'), ' ',
				btn('重启服务', 'cbi-button-apply', function() {
					return run(['restart']).then(function() { notify('已重启'); return refresh(); });
				}, '断开重连飞书，并清空 AI 的对话记录'), ' ',
				btn('解除绑定', 'cbi-button-reset', function() {
					if (!confirm('解除后，下一个给机器人发消息的人会成为新主人。确定？')) return;
					return run(['unbind']).then(function() { notify('已解除绑定'); return refresh(); });
				}, '清除已绑定的主人，下一个发消息的人重新绑定')
			]);

			poll.add(refresh, 5);
			refreshLogs();

			return E('div', {}, [
				E('h3', {}, '运行状态'), statusBox, buttons,
				formEl,
				E('h3', {}, '运行日志'),
				E('div', { 'style': 'margin-bottom:.5em;color:#888' }, ['最近 200 行。只记录收到的问题和执行的命令，不记录密钥。 ',
					btn('刷新日志', 'cbi-button-neutral', refreshLogs, '')]),
				logBox
			]);
		});
	}
});
