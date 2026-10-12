#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI 运维助手（luci-app-opsagent）
飞书机器人长连接（无需公网 IP）+ DeepSeek（OpenAI 兼容接口）
- 只认绑定的那一个飞书用户
- 只读命令直接执行；会改动系统的命令先在飞书里问「确认」
- 所有回传给大模型的输出都会抹掉已知密钥/令牌
"""
import asyncio, html as htmlmod, inspect, json, os, re, shlex, shutil, subprocess, sys, time, urllib.request, urllib.error, base64
from urllib.parse import urlparse, parse_qs

VERSION = "1.0.0-r10"
FEISHU = os.environ.get("OPSAGENT_FEISHU", "https://open.feishu.cn")
STATUS_FILE = os.environ.get("OPSAGENT_STATUS", "/tmp/opsagent.status")


try:
    import syslog
    syslog.openlog("opsagent")
except Exception:
    syslog = None


def log(*a):
    msg = " ".join(str(x) for x in a)
    if syslog and not sys.stdout.isatty() and not os.environ.get("OPSAGENT_NOSYSLOG"):
        syslog.syslog(syslog.LOG_INFO, msg)
    else:
        print(time.strftime("%H:%M:%S"), msg, flush=True)


# ---------------------------------------------------------------- 配置
def uci_get_all(pkg="opsagent", sec="main"):
    cfg = {}
    try:
        out = subprocess.run(["uci", "-q", "show", "%s.%s" % (pkg, sec)], capture_output=True, text=True).stdout
    except FileNotFoundError:
        return cfg
    for line in out.splitlines():
        m = re.match(r"^[^.]+\.[^.]+\.([^=]+)='?(.*?)'?$", line)
        if m:
            cfg[m.group(1)] = m.group(2).replace("'\\''", "'")
    return cfg


def uci_set(opt, val):
    try:
        subprocess.run(["uci", "set", "opsagent.main.%s=%s" % (opt, val)])
        subprocess.run(["uci", "commit", "opsagent"])
    except OSError as e:
        log("uci 写入失败：", e)


CFG = {}


def load_cfg():
    global CFG
    CFG = uci_get_all()
    if os.environ.get("OPSAGENT_TEST_CFG"):
        CFG.update(json.loads(os.environ["OPSAGENT_TEST_CFG"]))


def cfg_int(k, d):
    try:
        return int(CFG.get(k) or d)
    except ValueError:
        return d


# ---------------------------------------------------------------- 状态文件（给 LuCI 看）
STATE = {"state": "starting", "since": int(time.time()), "version": VERSION}


def set_state(**kw):
    STATE.update(kw)
    try:
        with open(STATUS_FILE + ".tmp", "w") as f:
            json.dump(STATE, f, ensure_ascii=False)
        os.replace(STATUS_FILE + ".tmp", STATUS_FILE)
    except OSError:
        pass


# ---------------------------------------------------------------- 脱敏
_SECRETS = set()


def collect_secrets():
    s = set()
    for k in ("app_secret", "api_key", "agh_pass", "github_token", "cf_token", "tavily_key"):
        if len(CFG.get(k, "")) >= 8:
            s.add(CFG[k])
    try:  # cftunnel 等插件里的令牌
        out = subprocess.run(["uci", "-q", "show"], capture_output=True, text=True).stdout
        for line in out.splitlines():
            m = re.match(r"^[^=]*(token|secret|password|passwd|key|psk)[^=]*='?(.*?)'?$", line, re.I)
            if m and len(m.group(2)) >= 8:
                s.add(m.group(2))
    except Exception:
        pass
    _SECRETS.clear()
    _SECRETS.update(s)


_RX = [
    (re.compile(r"(--token[ =])\S+"), r"\1***"),
    (re.compile(r"eyJ[A-Za-z0-9_\-]{20,}(\.[A-Za-z0-9_\-]+)*"), "***"),
    (re.compile(r"sk-[A-Za-z0-9]{16,}"), "sk-***"),
    (re.compile(r"(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}"), "gh-***"),
    (re.compile(r"(x-access-token:)[^@\s]+@"), r"\1***@"),
    (re.compile(r"(?i)((?:password|passwd|secret|token|api_key|apikey|psk|key)\s*[=:]\s*['\"]?)[^\s'\"]{6,}"), r"\1***"),
    (re.compile(r"\$2[aby]\$\d+\$[./A-Za-z0-9]{40,}"), "***"),
    (re.compile(r"(?i)(option\s+\S*(?:key|password|secret|token|psk)\S*\s+)'[^']*'"), r"\1'***'"),
]


def redact(t):
    for s in sorted(_SECRETS, key=len, reverse=True):
        t = t.replace(s, "***")
    for rx, rep in _RX:
        t = rx.sub(rep, t)
    return t


# ---------------------------------------------------------------- 命令分级
SENSITIVE_PATH = re.compile(r"(/etc/shadow|/etc/passwd-|/etc/config/opsagent|/etc/config/cftunnel|adguardhome\.ya?ml|/\.ssh|/etc/dropbear|\.key$|\.pem$|/etc/ssl/private|/proc/\d+/environ|/proc/self/environ)")
SIMPLE_RO = {"uptime", "free", "df", "date", "uname", "hostname", "id", "whoami", "which", "du", "stat", "pidof", "pgrep",
             "ps", "netstat", "ss", "lsblk", "blkid", "nproc", "vmstat", "ifstatus", "iwinfo", "nslookup", "traceroute",
             "traceroute6", "dig", "host", "cat", "head", "tail", "grep", "egrep", "fgrep", "wc", "sort", "uniq", "cut",
             "tr", "ls", "dmesg", "logread", "mount", "lsmod", "arp", "route", "ifconfig", "md5sum", "sha256sum",
             "file", "readlink", "realpath", "basename", "dirname", "echo", "true", "column", "nl", "jq", "sensors",
             "top", "ping", "ping6", "ip", "uci", "ubus", "apk", "opkg", "curl", "wget", "nft", "iptables", "ip6tables",
             "ethtool", "brctl", "conntrack", "service", "fw4", "lscpu"}
DANGER = re.compile(r"(\brm\s+-[a-z]*r[a-z]*f?\s+/(\s|$|\*)|\bmkfs|\bmtd\b|\bfirstboot\b|\bdd\b.*\bof=/dev/|\bjffs2reset\b|>\s*/dev/mmcblk|\bsysupgrade\b|:\(\)\s*\{)")


def _seg_readonly(argv):
    if not argv:
        return False, "空命令"
    c = os.path.basename(argv[0]) if argv[0].startswith("/etc/init.d/") is False else argv[0]
    args = argv[1:]
    joined = " ".join(args)
    if any(SENSITIVE_PATH.search(a) for a in args):
        return False, "涉及敏感文件"
    if argv[0].startswith("/etc/init.d/"):
        return (len(args) == 1 and args[0] in ("status", "enabled", "info")), "init 脚本只读子命令"
    if c not in SIMPLE_RO:
        return False, "不在只读白名单"
    if c in ("grep", "egrep", "fgrep") and re.search(r"(^|\s)-[a-zA-Z]*[rR]", joined):
        return False, "递归 grep"
    if c in ("logread", "tail") and re.search(r"(^|\s)-[a-zA-Z]*f|--follow", joined):
        return False, "-f 会一直挂着"
    if c in ("ping", "ping6") and not re.search(r"(^|\s)-c\s*\d+", joined):
        return False, "ping 需要 -c 次数"
    if c == "top" and not ("-b" in joined and "-n" in joined):
        return False, "top 需要 -b -n1"
    if c == "uci":
        if not args or args[0] not in ("show", "get", "changes", "export"):
            return False, "uci 写操作"
        if len(args) < 2 or re.match(r"^(opsagent|cftunnel)(\.|$)", args[1]):
            return False, "uci 需指定配置且不能读密钥配置"
    if c == "ubus":
        ok = args[:1] == ["list"] or (len(args) >= 3 and args[0] == "call" and (
            args[1] in ("system", "luci-rpc") and args[2] in ("board", "info", "getNetworkDevices", "getDHCPLeases")
            or args[1].startswith("network.interface") and args[2] in ("status", "dump")
            or args[1] == "service" and args[2] == "list"
            or args[1] == "network.device" and args[2] == "status"))
        return ok, "ubus 只读调用"
    if c in ("apk", "opkg"):
        return (bool(args) and args[0] in ("info", "list", "search", "version", "policy", "list-installed", "status", "dot")), "包管理只读"
    if c == "ip":
        bad = {"add", "del", "delete", "change", "replace", "set", "flush", "append", "prepend", "save", "restore", "exec"}
        return (not (bad & set(args))), "ip 写操作"
    if c in ("nft",):
        return (args[:2] in (["list", "ruleset"], ["list", "tables"]) or (args and args[0] == "list")), "nft 只读"
    if c in ("iptables", "ip6tables"):
        return bool(re.search(r"(^|\s)-(L|S)|--list", joined)) and not re.search(r"(^|\s)-(A|D|I|R|F|X|N|P|Z)\b", joined), "iptables 只读"
    if c == "fw4":
        return (args[:1] in (["print"], ["check"])), "fw4 只读"
    if c == "service":
        return (len(args) <= 1), "service 列表"
    if c == "curl":
        joined = re.sub(r"(-o|--output)\s+/dev/null", "", joined)
        if re.search(r"(^|\s)(-o|-O|--output|-T|--upload-file|-d|--data\S*|-F|--form|-X|--request|-K|--config|--remote-name\S*)\b", joined):
            return False, "curl 写/上传参数"
    if c == "wget":
        if not re.search(r"(-O\s*-|--spider|-qO-|-O-)", joined):
            return False, "wget 只允许输出到屏幕"
    if c in ("ifconfig", "route", "arp", "brctl", "ethtool", "conntrack") and re.search(r"\b(up|down|add|del|addbr|delbr|addif|delif|-s|-d|-F|-D|-s\b)\b", joined):
        return False, "网络写操作"
    if c == "mount" and args:
        return False, "mount 带参数"
    if c == "date" and re.search(r"(^|\s)-s", joined):
        return False, "改时间"
    if c == "hostname" and args:
        return False, "改主机名"
    if c == "echo":
        return True, ""
    return True, ""


def _segments(cmd):
    """按 shell 语法切成简单命令；只允许 ; && || | 连接和 >/dev/null、2>&1 这类无害重定向。
    返回 (段列表, 不安全原因)"""
    if "`" in cmd or "$(" in cmd or "<(" in cmd or ">(" in cmd:
        return None, "含子命令"
    lx = shlex.shlex(cmd, posix=True, punctuation_chars=";&|<>")
    lx.whitespace_split = True
    try:
        toks = list(lx)
    except ValueError:
        return None, "无法解析"
    segs, cur, i = [], [], 0
    while i < len(toks):
        t = toks[i]
        if t in (";", "&&", "||", "|", ";;"):
            if cur:
                segs.append(cur)
            cur = []
        elif t in (">", ">>", "&>", ">&", ">|", "<", "<<"):
            nxt = toks[i + 1] if i + 1 < len(toks) else ""
            if t == "<":
                pass  # 读文件作输入，参数检查交给敏感路径规则
            elif not (nxt == "/dev/null" or (t == ">&" and nxt in ("1", "2"))):
                return None, "重定向写文件"
            if cur and cur[-1] in ("1", "2"):
                cur.pop()  # 2>/dev/null 里的 2
            i += 1
        elif t == "&" or set(t) <= set(";&|<>"):
            return None, "后台运行或复杂语法"
        else:
            cur.append(t)
        i += 1
    if cur:
        segs.append(cur)
    return segs, ""


def classify(cmd):
    """返回 ('ro'|'rw'|'deny', 说明)"""
    cmd = cmd.strip()
    if not cmd:
        return "deny", "空命令"
    if DANGER.search(cmd):
        return "deny", "高危命令（刷机/清盘/格式化），请自己 SSH 执行"
    if SENSITIVE_PATH.search(cmd) or re.search(r"\buci\s+(show|get|export)\s+(opsagent|cftunnel)\b", cmd):
        return "deny", "涉及密码/密钥文件，不允许读取"
    segs, why = _segments(cmd)
    if segs is None:
        return "rw", why
    if not segs:
        return "deny", "空命令"
    for argv in segs:
        ok, why = _seg_readonly(argv)
        if not ok:
            return "rw", why
    return "ro", "只读"


NAS_DANGER = re.compile(r"(\bmkfs|\bwipefs\b|\bfdisk\b|\bsfdisk\b|\bgdisk\b|\bsgdisk\b|\bparted\b|\bblkdiscard\b|\bshred\b"
                        r"|\bdd\b.*\bof=/dev/|>\s*/dev/(sd|nvme|md|mmcblk|dm-)|\bmdadm\b.*--(create|zero-superblock|stop|remove|fail)"
                        r"|\bzpool\s+(destroy|create|labelclear)|\bpvremove\b|\bvgremove\b|\blvremove\b|\bcryptsetup\s+luksFormat"
                        r"|\brm\s+-[a-z]*r[a-z]*\s+(--no-preserve-root\s+)?/(\s|$|\*)|\brm\s+-[a-z]*r[a-z]*\s+/vol\d+/?(\s|$|\*)|:\(\)\s*\{)")


def nas_on():
    return bool(CFG.get("nas_host"))


def classify_nas(cmd):
    """NAS：格式化/清盘类需要确认；其余按设置决定"""
    cmd = cmd.strip()
    if not cmd:
        return "deny", "空命令"
    if NAS_DANGER.search(cmd):
        return "danger", "格式化/清盘/删整卷"
    if CFG.get("nas_auto", "1") == "1":
        return "ro", "NAS 改动免确认"
    k, why = classify(cmd)
    return ("rw" if k == "deny" else k), why


_gh_me = {}


def gh_me():
    if not _gh_me and CFG.get("github_token"):
        try:
            j = gh_call("GET", "/user")
            if j.get("login"):
                _gh_me.update(login=j["login"], email="%s+%s@users.noreply.github.com" % (j.get("id"), j["login"]))
        except Exception:
            pass
    return _gh_me


def nas_prefix():
    tok = CFG.get("github_token")
    if not tok:
        return ""
    me = gh_me()
    kv = [("credential.https://github.com.helper", '!f(){ echo username=x-access-token; echo "password=$GH_TOKEN"; }; f')]
    if me:
        kv += [("user.name", me["login"]), ("user.email", me["email"])]
    env = {"GH_TOKEN": tok, "GITHUB_TOKEN": tok, "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_COUNT": str(len(kv))}
    for i, (k, v) in enumerate(kv):
        env["GIT_CONFIG_KEY_%d" % i], env["GIT_CONFIG_VALUE_%d" % i] = k, v
    return "export " + " ".join("%s=%s" % (k, shlex.quote(v)) for k, v in env.items()) + "\n"


def run_nas(cmd, timeout):
    cmd = nas_prefix() + cmd
    argv = ["dbclient", "-y", "-T", "-i", CFG.get("nas_key") or "/etc/opsagent/nas_key",
            "-p", CFG.get("nas_port") or "22", "%s@%s" % (CFG.get("nas_user") or "root", CFG["nas_host"]), cmd]
    return run_shell(argv, timeout, limit=10000)


def run_shell(cmd, timeout, limit=6000):
    try:
        env = dict(os.environ)
        if CFG.get("agh_user") and CFG.get("agh_pass"):
            env["AGH_AUTH"] = "%s:%s" % (CFG["agh_user"], CFG["agh_pass"])
        p = subprocess.Popen(cmd if isinstance(cmd, list) else ["/bin/sh", "-c", cmd], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, env=env)
        try:
            out, _ = p.communicate(timeout=timeout)
            rc = p.returncode
        except subprocess.TimeoutExpired:
            p.kill()
            out, _ = p.communicate()
            rc = "超时(%ss)被终止" % timeout
        t = out.decode("utf-8", "replace")
    except Exception as e:
        t, rc = str(e), "执行失败"
    t = redact(t)
    t = re.sub(r"\n?dbclient: Connection to \S+ exited: Interrupted\.\n?", "", t)
    if len(t) > limit:
        h = limit * 2 // 5
        t = t[:h] + "\n…（中间省略 %d 字）…\n" % (len(t) - 2 * h) + t[-h:]
    return "退出码: %s\n%s" % (rc, t or "（无输出）")


# ---------------------------------------------------------------- HTTP
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
def _http_json(url, body=None, headers=None, timeout=30, method=None):
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json; charset=utf-8"}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=h, method=method or ("POST" if data else "GET"))
    for attempt in range(3):
        try:
            with _OPENER.open(req, timeout=timeout) as r:
                return json.loads(r.read().decode() or "{}")
        except urllib.error.HTTPError:
            raise
        except (urllib.error.URLError, OSError) as e:
            if attempt == 2:
                raise RuntimeError("网络错误（%s）：%s" % (urlparse(url).hostname, getattr(e, "reason", e)))
            time.sleep(2 + attempt * 3)


def http_json(url, body=None, headers=None, timeout=30, method=None):
    try:
        return _http_json(url, body, headers, timeout, method)
    except urllib.error.HTTPError as e:
        txt = e.read().decode("utf-8", "replace")
        try:
            j = json.loads(txt)
        except ValueError:
            j = {"msg": txt[:300]}
        j.setdefault("http_status", e.code)
        return j


# ---------------------------------------------------------------- 飞书
_tok = {"v": "", "exp": 0}


def feishu_token():
    if _tok["v"] and time.time() < _tok["exp"] - 120:
        return _tok["v"]
    j = http_json(FEISHU + "/open-apis/auth/v3/tenant_access_token/internal",
                  {"app_id": CFG.get("app_id"), "app_secret": CFG.get("app_secret")})
    if j.get("code") != 0:
        raise RuntimeError("飞书鉴权失败：%s %s" % (j.get("code"), j.get("msg")))
    _tok["v"], _tok["exp"] = j["tenant_access_token"], time.time() + int(j.get("expire", 7200))
    return _tok["v"]


def feishu_send(target, text):
    """target 以 oc_ 开头按会话 chat_id 发（私聊必须这样，否则飞书报 230101），否则按 open_id"""
    rid = "chat_id" if target.startswith("oc_") else "open_id"
    text = text.strip() or "（空）"
    parts = [text[i:i + 3800] for i in range(0, len(text), 3800)][:4]
    for p in parts:
        j = http_json(FEISHU + "/open-apis/im/v1/messages?receive_id_type=" + rid,
                      {"receive_id": target, "msg_type": "text", "content": json.dumps({"text": p}, ensure_ascii=False)},
                      {"Authorization": "Bearer " + feishu_token()})
        if j.get("code") != 0:
            log("发送飞书消息失败:", j.get("code"), j.get("msg"))


def feishu_user_name(open_id):
    try:
        j = http_json(FEISHU + "/open-apis/contact/v3/users/%s?user_id_type=open_id" % open_id,
                      headers={"Authorization": "Bearer " + feishu_token()})
        return j.get("data", {}).get("user", {}).get("name", "")
    except Exception:
        return ""


# ---------------------------------------------------------------- 最小 protobuf（pbbp2.Frame）
def _varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _rd_varint(b, i):
    n = s = 0
    while True:
        x = b[i]
        i += 1
        n |= (x & 0x7F) << s
        s += 7
        if not x & 0x80:
            return n, i


def _fields(b):
    i = 0
    while i < len(b):
        key, i = _rd_varint(b, i)
        fn, wt = key >> 3, key & 7
        if wt == 0:
            v, i = _rd_varint(b, i)
        elif wt == 2:
            ln, i = _rd_varint(b, i)
            v = bytes(b[i:i + ln])
            i += ln
        elif wt == 1:
            v = b[i:i + 8]; i += 8
        elif wt == 5:
            v = b[i:i + 4]; i += 4
        else:
            raise ValueError("bad wire type")
        yield fn, wt, v


def frame_decode(b):
    f = {"SeqID": 0, "LogID": 0, "service": 0, "method": 0, "headers": [], "payload": b""}
    names = {1: "SeqID", 2: "LogID", 3: "service", 4: "method", 6: "payload_encoding", 7: "payload_type", 8: "payload", 9: "LogIDNew"}
    for fn, wt, v in _fields(b):
        if fn == 5:
            h = {}
            for hf, _, hv in _fields(v):
                h["key" if hf == 1 else "value"] = hv.decode()
            f["headers"].append([h.get("key", ""), h.get("value", "")])
        elif fn in names:
            f[names[fn]] = v.decode() if fn in (6, 7, 9) else v
    return f


def frame_encode(f):
    def ld(fn, data):
        return _varint(fn << 3 | 2) + _varint(len(data)) + data

    def vi(fn, n):
        if n < 0:
            n += 1 << 64
        return _varint(fn << 3) + _varint(n)

    out = vi(1, f.get("SeqID", 0)) + vi(2, f.get("LogID", 0)) + vi(3, f.get("service", 0)) + vi(4, f.get("method", 0))
    for k, v in f.get("headers", []):
        out += ld(5, ld(1, k.encode()) + ld(2, v.encode()))
    for fn, k in ((6, "payload_encoding"), (7, "payload_type")):
        if f.get(k):
            out += ld(fn, f[k].encode())
    if f.get("payload"):
        out += ld(8, f["payload"])
    if f.get("LogIDNew"):
        out += ld(9, f["LogIDNew"].encode())
    return out


def hget(f, k):
    for hk, hv in f["headers"]:
        if hk == k:
            return hv
    return ""


# ---------------------------------------------------------------- 大模型
TOOLS = [{
    "type": "function",
    "function": {
        "name": "run_command",
        "description": "在这台路由器（BusyBox ash，root 权限）上执行一条 shell 命令。只读命令（查看状态、日志、配置）会立即执行并返回输出；"
                       "会改动系统的命令（重启服务、改配置、装包等）会先发给用户确认，用户点头才执行。命令必须非交互、能自己结束（ping 加 -c，top 用 -b -n1，不要 -f 跟随）。",
        "parameters": {"type": "object", "properties": {
            "command": {"type": "string", "description": "要执行的完整命令"},
            "reason": {"type": "string", "description": "一句话说明为什么执行它（会展示给用户）"}},
            "required": ["command", "reason"]}}}]

NAS_TOOL = {
    "type": "function",
    "function": {
        "name": "nas_command",
        "description": "通过 SSH 在用户的 NAS（飞牛 fnOS，Debian 12，bash，root 权限）上执行一条命令。NAS 是用户开发和测试应用的机器，"
                       "你可以直接装包、写文件、改配置、跑 docker/git/编译，不用问用户；只有格式化、清盘、删整个存储卷这类会先请用户确认。"
                       "命令非交互（apt 加 -y，git 不要弹编辑器）。耗时长的（编译、拉镜像）设大 timeout_sec；超过 30 分钟的任务用 nohup … > 日志 2>&1 & 放后台，之后再查日志。"
                       "写多行文件用 cat > 文件 <<'EOF' … EOF。",
        "parameters": {"type": "object", "properties": {
            "command": {"type": "string", "description": "要执行的完整命令（可以是多行脚本）"},
            "reason": {"type": "string", "description": "一句话说明在做什么（会展示给用户）"},
            "timeout_sec": {"type": "integer", "description": "超时秒数，默认 120，最大 1800"}},
            "required": ["command", "reason"]}}}


GH_TOOL = {
    "type": "function",
    "function": {
        "name": "github_api",
        "description": "调用 GitHub REST API（https://api.github.com），以用户自己的账号身份。可以查仓库、Actions 构建状态和日志摘要、Release、Issue/PR，"
                       "也可以触发 workflow（POST /repos/{o}/{r}/actions/workflows/{id}/dispatches）、建 Release、建仓库（POST /user/repos）等。"
                       "GET/POST/PATCH/PUT 直接执行；DELETE（删仓库、删 Release、删分支等）会先请用户确认。推代码请在 NAS 上用 git，不要用这个工具传文件。",
        "parameters": {"type": "object", "properties": {
            "method": {"type": "string", "enum": ["GET", "POST", "PATCH", "PUT", "DELETE"]},
            "path": {"type": "string", "description": "以 / 开头的 API 路径，可带查询参数，如 /repos/OWNER/REPO/actions/runs?per_page=5"},
            "body": {"type": "object", "description": "POST/PATCH/PUT 的 JSON 内容"},
            "reason": {"type": "string", "description": "一句话说明在做什么"}},
            "required": ["method", "path", "reason"]}}}


def gh_call(method, path, body=None):
    if not path.startswith("/"):
        path = "/" + path
    return http_json("https://api.github.com" + path, body if method != "GET" else None,
                     {"Authorization": "Bearer " + CFG.get("github_token", ""), "Accept": "application/vnd.github+json",
                      "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "opsagent"}, timeout=30, method=method)


def _slim(o, depth=0):
    """去掉 GitHub 返回里大量无用的 *_url 字段，省 token"""
    if isinstance(o, dict):
        return {k: _slim(v, depth + 1) for k, v in o.items()
                if not (k.endswith("_url") and k not in ("html_url", "browser_download_url", "clone_url")) and k not in ("node_id", "_links")
                and not (depth > 0 and k in ("owner", "repository", "head_repository", "actor", "triggering_actor", "uploader", "author", "committer", "user"))}
    if isinstance(o, list):
        return [_slim(v, depth + 1) for v in o]
    return o


def run_gh(method, path, body):
    try:
        j = gh_call(method, path, body)
    except Exception as e:
        return "请求失败：%s" % e
    t = redact(json.dumps(_slim(j), ensure_ascii=False))
    if len(t) > 8000:
        t = t[:7800] + "…（已截断，可以加 per_page 或更具体的路径）"
    return t


CF_TOOL = {
    "type": "function",
    "function": {
        "name": "cloudflare_api",
        "description": "调用 Cloudflare API（https://api.cloudflare.com/client/v4），管理用户的隧道（Cloudflare Tunnel）和域名 DNS。"
                       "常用：GET /zones、GET/POST /zones/{zone_id}/dns_records、GET /accounts/{account_id}/cfd_tunnel?is_deleted=false、"
                       "GET/PUT /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations（公网主机名 ingress 规则）。"
                       "GET 和 POST（新建）直接执行；PUT/PATCH/DELETE（改、删）会先请用户确认。改隧道 ingress 是整体替换：先 GET 现有配置，在原有规则基础上增改，"
                       "保留末尾的 http_status:404 兜底，绝不能丢掉已有主机名。给新主机名接隧道还要建一条 CNAME 指向 <tunnel_id>.cfargotunnel.com（proxied=true）。",
        "parameters": {"type": "object", "properties": {
            "method": {"type": "string", "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"]},
            "path": {"type": "string", "description": "以 / 开头的路径，如 /zones?name=example.com"},
            "body": {"type": "object", "description": "POST/PUT/PATCH 的 JSON 内容"},
            "reason": {"type": "string", "description": "一句话说明在做什么"}},
            "required": ["method", "path", "reason"]}}}


def _uci1(k):
    try:
        return subprocess.run(["uci", "-q", "get", k], capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        return ""


def cf_creds():
    if CFG.get("cf_enable", "1") != "1":
        return "", ""
    tok = CFG.get("cf_token") or _uci1("cftunnel.main.api_token")
    acc = CFG.get("cf_account") or _uci1("cftunnel.main.account_id")
    return tok, acc


def cf_on():
    return bool(cf_creds()[0])


def cf_call(method, path, body=None):
    if not path.startswith("/"):
        path = "/" + path
    tok, acc = cf_creds()
    path = path.replace("{account_id}", acc)
    return http_json("https://api.cloudflare.com/client/v4" + path, body if method != "GET" else None,
                     {"Authorization": "Bearer " + tok}, timeout=30, method=method)


def run_cf(method, path, body):
    try:
        j = cf_call(method, path, body)
    except Exception as e:
        return "请求失败：%s" % e
    if isinstance(j, dict):
        for k in ("messages", "result_info"):
            if not j.get(k):
                j.pop(k, None)
        r = j.get("result")
        if isinstance(r, dict) and "token" in r:
            r["token"] = "***"
    t = redact(json.dumps(j, ensure_ascii=False))
    if len(t) > 8000:
        t = t[:7800] + "…（已截断，可以加 per_page 或过滤参数）"
    return t


# ---------------------------------------------------------------- 联网搜索
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

WEB_TOOLS = [{
    "type": "function",
    "function": {
        "name": "web_search",
        "description": "联网搜索（必应）。用户问天气、新闻、价格、版本号、赛事、政策、某软件怎么配置等实时或你不确定的信息时先搜，再根据结果回答；"
                       "摘要不够就用 web_fetch 打开一两个最相关的链接读正文。关键词用搜索引擎的写法，必要时带上年份。",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string", "description": "搜索关键词"},
            "count": {"type": "integer", "description": "返回条数，默认 8，最多 15"}},
            "required": ["query"]}}}, {
    "type": "function",
    "function": {
        "name": "web_fetch",
        "description": "打开一个网页（http/https），返回去掉 HTML 后的正文文字（最多约 8000 字）。也可直接读 JSON/文本接口，"
                       "例如天气：https://wttr.in/上海?format=j1&lang=zh 或 https://wttr.in/上海?lang=zh&format=4。",
        "parameters": {"type": "object", "properties": {
            "url": {"type": "string"},
            "max_chars": {"type": "integer", "description": "最多返回多少字，默认 8000"}},
            "required": ["url"]}}}]


def web_on():
    return CFG.get("search_enable", "1") == "1"


def _strip_html(s):
    s = re.sub(r"(?is)<(script|style|noscript|svg|head)[^>]*>.*?</\1>", " ", s)
    s = re.sub(r"(?is)<br\s*/?>|</(p|div|li|h[1-6]|tr|section|article)>", "\n", s)
    s = re.sub(r"(?s)<[^>]+>", " ", s)
    s = htmlmod.unescape(s)
    s = re.sub(r"[ \t\r\f\v\u00a0]+", " ", s)
    return re.sub(r"\n\s*\n+", "\n", s).strip()


def http_text(url, timeout=20, limit=3 * 1024 * 1024):
    from urllib.parse import quote
    url = quote(url, safe=":/?&=%#+,;@!$'()*~[]")  # 中文路径/参数
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6",
                                               "Accept": "text/html,application/json,text/plain,*/*"})
    with _OPENER.open(req, timeout=timeout) as r:
        raw = r.read(limit)
        ctype = r.headers.get("Content-Type", "")
    m = re.search(r"charset=([\w-]+)", ctype) or re.search(rb'<meta[^>]+charset=["\']?([\w-]+)', raw[:4096])
    enc = m.group(1) if m else "utf-8"
    if isinstance(enc, bytes):
        enc = enc.decode()
    try:
        txt = raw.decode(enc, "replace")
    except LookupError:
        txt = raw.decode("utf-8", "replace")
    return txt, ctype


def _bing_url(u):
    u = htmlmod.unescape(u)
    m = re.search(r"[?&]u=a1([^&]+)", u)
    if "bing.com/ck/a" in u and m:
        try:
            b = m.group(1)
            return base64.urlsafe_b64decode(b + "=" * (-len(b) % 4)).decode()
        except Exception:
            pass
    return u


def parse_bing(h, n=8):
    out = []
    for blk in re.split(r'<li class="b_algo"', h)[1:]:
        m = re.search(r'(?s)<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>', blk)
        if not m:
            continue
        p = re.search(r"(?s)<p[^>]*>(.*?)</p>", blk) or re.search(r'(?s)<div class="b_caption"[^>]*>(.*?)</div>', blk)
        out.append({"title": _strip_html(m.group(2)), "url": _bing_url(m.group(1)),
                    "snippet": _strip_html(p.group(1))[:300] if p else ""})
        if len(out) >= n:
            break
    return out


def search(query, n=8):
    n = max(1, min(int(n or 8), 15))
    if CFG.get("search_engine") == "tavily" and CFG.get("tavily_key"):
        j = http_json("https://api.tavily.com/search", {"query": query, "max_results": n, "include_answer": True},
                      {"Authorization": "Bearer " + CFG["tavily_key"]}, timeout=30)
        if "results" in j:
            res = [{"title": r.get("title", ""), "url": r.get("url", ""), "snippet": (r.get("content") or "")[:400]} for r in j["results"]]
            return res, j.get("answer") or ""
        log("Tavily 失败，改用必应：", str(j)[:200])
    from urllib.parse import quote
    h, _ = http_text("https://cn.bing.com/search?q=%s&count=%d&ensearch=0" % (quote(query), n + 2))
    return parse_bing(h, n), ""


def run_search(query, n):
    try:
        res, ans = search(query, n)
    except Exception as e:
        return "搜索失败：%s" % e
    if not res:
        return "没有搜到结果，换个关键词试试。"
    lines = (["摘要：" + ans] if ans else []) + ["%d. %s\n%s\n%s" % (i + 1, r["title"], r["url"], r["snippet"]) for i, r in enumerate(res)]
    return redact("\n".join(lines))


def run_fetch(url, max_chars):
    if not re.match(r"^https?://", url or ""):
        return "只支持 http/https 链接"
    try:
        lim = max(500, min(int(max_chars or 8000), 20000))
    except (TypeError, ValueError):
        lim = 8000
    try:
        txt, ctype = http_text(url)
    except urllib.error.HTTPError as e:
        return "打开失败：HTTP %s" % e.code
    except Exception as e:
        return "打开失败：%s" % getattr(e, "reason", e)
    if "html" in ctype or txt.lstrip()[:1] == "<":
        t = re.search(r"(?is)<title[^>]*>(.*?)</title>", txt)
        txt = (("标题：" + _strip_html(t.group(1)) + "\n") if t else "") + _strip_html(txt)
    if len(txt) > lim:
        txt = txt[:lim] + "\n…（后面还有 %d 字，已截断）" % (len(txt) - lim)
    return redact(txt)


def gh_on():
    return bool(CFG.get("github_token"))


def tools():
    return TOOLS + ([NAS_TOOL] if nas_on() else []) + ([GH_TOOL] if gh_on() else []) + ([CF_TOOL] if cf_on() else []) + (WEB_TOOLS if web_on() else [])

SYS_PROMPT = """你是「N1 运维助手」，运行在用户家里的斐讯 N1 软路由上，通过飞书和用户（这台设备的主人）对话。
设备信息：{board}
网络环境：N1 是旁路由，局域网 IP 192.168.2.254；主路由 TP-Link 192.168.2.1 负责拨号、网关和 DHCP。
本机服务：dnsmasq（53 端口，上游转发给 AdGuard Home 127.0.0.1:5335，管理页 :3000）、Cloudflare 隧道（cftunnel/cloudflared）、dropbear SSH、LuCI。系统是 iStoreOS（OpenWrt 25.12，包管理器 apk，配置用 uci）。
工作方式：
- 需要了解情况就调用 run_command，先查再下结论，不要编造输出。能一条命令查清的不要分多次。
- 改动系统前先用只读命令确认现状。{router}
- 不要读取或输出密码、令牌、私钥；输出里的 *** 是已脱敏的内容。
- 回答用简体中文，纯文本（不要用 Markdown 表格），简洁，先给结论；数字带单位。
{agh}
{nas}
{gh}
{cf}
{web}
当前时间：{now}"""


def llm(messages):
    url = CFG.get("base_url", "https://api.deepseek.com").rstrip("/") + "/chat/completions"
    j = http_json(url, {"model": CFG.get("model") or "deepseek-flash", "messages": messages, "tools": tools(), "temperature": 0.2},
                  {"Authorization": "Bearer " + CFG.get("api_key", "")}, timeout=120)
    if "choices" not in j:
        err = j.get("error", {})
        raise RuntimeError("大模型接口出错：%s %s" % (j.get("http_status", ""), err.get("message") if isinstance(err, dict) else j))
    return j["choices"][0]["message"]


# ---------------------------------------------------------------- 对话逻辑
SESSION_FILE = "/tmp/opsagent.session.json"


class Agent:
    def __init__(self):
        self.history = []
        self.pending = None  # {"cmd","reason","ts"}
        self.lock = asyncio.Lock()
        self.board = ""
        try:  # 插件重启后接着上次的对话和待确认命令
            with open(SESSION_FILE) as f:
                j = json.load(f)
            if time.time() - j.get("ts", 0) < 6 * 3600:
                self.history, self.pending = j.get("history") or [], j.get("pending")
        except Exception:
            pass

    def save(self):
        try:
            with open(SESSION_FILE + ".tmp", "w") as f:
                json.dump({"ts": time.time(), "history": self.history, "pending": self.pending}, f, ensure_ascii=False)
            os.chmod(SESSION_FILE + ".tmp", 0o600)
            os.replace(SESSION_FILE + ".tmp", SESSION_FILE)
        except Exception as e:
            log("保存会话失败：", e)

    def sys_msg(self):
        return {"role": "system", "content": SYS_PROMPT.format(agh=("- AdGuard Home 接口需要登录，已放在环境变量里：curl -s -u \"$AGH_AUTH\" http://127.0.0.1:3000/control/stats（今日统计，num_blocked_filtering 是拦截数），/control/status、/control/querylog?limit=20 同理。" if CFG.get("agh_pass") else "- AdGuard Home 接口需要登录，但用户没在插件里填账号，查不到统计时请告诉用户去 LuCI → AI 运维助手 → 高级 里填。"), nas=("- 用户的 NAS（%s，飞牛 fnOS / Debian 12）用 nas_command 操作，你在上面有 root 权限，用来长期开发、测试应用：放手去做，装环境、写代码、构建、运行、看日志都直接执行，每完成一个阶段简短汇报进度。系统盘（/）很小，开发项目、数据、docker 卷都放 NAS 的 /vol1/dev/<项目名>（不存在就建），不要往 /root 或系统盘塞大文件。路由器（N1）上虽然装了 docker 但不跑用户的容器；用户说的 docker、容器、项目、开发，默认都是指 NAS，用 nas_command，不要同时在路由器上查。只有明确说路由器/N1/AdGuard/DNS/隧道时才用 run_command。" % CFG.get("nas_host") if nas_on() else ""), gh=("- 已接入用户的 GitHub（账号 %s）：查询/触发构建/发 Release 用 github_api；在 NAS 上 git clone/push https://github.com/... 已自动带上凭据（环境变量 GH_TOKEN 也可用），不要把令牌写进文件或 remote 地址。" % (gh_me().get("login") or "?") if gh_on() else ""), cf=("- 已接入用户的 Cloudflare（account_id=%s，路径里可直接写 {account_id}）：用 cloudflare_api 管隧道和 DNS。路由器上跑着隧道 n1（ssh.007.cc.cd 等，是远程维护通道，千万别删改坏），NAS 上有隧道 oes；在 NAS 上做的应用要对外访问时，优先给 oes 隧道加公网主机名。" % cf_creds()[1] if cf_on() else ""), router=("用户已允许你在路由器上直接改配置、装/卸软件、重启服务，不用确认；但动手前想清楚影响，别断掉自己的网络（dnsmasq/AdGuard/隧道 n1/防火墙/网络接口），改 uci 前先备份原值，改完验证并汇报改了什么。" if CFG.get("router_auto", "0") == "1" else "改动类命令会自动请用户确认，你不用再问一遍。"), web=("- 你可以联网：web_search 搜索、web_fetch 打开网页。日常问题（翻译、写代码、解释概念等）直接回答；涉及实时信息（天气、新闻、价格、汇率、版本更新、赛事、政策）或你不确定的事实，一定先搜再答，不要凭记忆编，回答末尾附上 1~3 个来源链接。天气直接 web_fetch wttr.in。" if web_on() else "- 你没有联网能力，实时信息（天气、新闻、价格）请说明无法确认。"), board=self.board, now=time.strftime("%Y-%m-%d %H:%M %a"))}

    def trim(self):
        n = cfg_int("history", 30)
        h = self.history[-n:]
        while h and h[0]["role"] != "user":
            h.pop(0)
        self.history = h

    def send(self, text):
        feishu_send(CFG.get("owner_chat_id") or CFG["owner_open_id"], text)

    def think(self, user_text):
        """同步：跑一轮工具循环，返回给用户的文本"""
        self.history.append({"role": "user", "content": user_text})
        self.trim()
        for _ in range(cfg_int("max_steps", 30)):
            msg = llm([self.sys_msg()] + self.history)
            calls = msg.get("tool_calls") or []
            keep = {"role": "assistant", "content": msg.get("content") or ""}
            if calls:
                keep["tool_calls"] = calls
                if msg.get("reasoning_content"):
                    keep["reasoning_content"] = msg["reasoning_content"]
            self.history.append(keep)
            if not calls:
                return msg.get("content") or "（模型没有返回内容）"
            stop = None
            for c in calls:
                res = self.tool(c)
                self.history.append({"role": "tool", "tool_call_id": c.get("id", ""), "content": res})
                if res.startswith("[等待确认]"):
                    stop = res
            if stop:
                # 清掉 reasoning_content，下一轮由用户的确认消息继续
                for m in self.history:
                    m.pop("reasoning_content", None)
                p = self.pending
                pre = (msg.get("content") or "").strip()
                return ((pre + "\n\n") if pre else "") + \
                    "⚠️ 需要你确认才会执行" + ("（NAS）" if p.get("nas") else "") + "：\n%s\n\n原因：%s\n\n回复「确认」执行，回复「取消」放弃（%d 分钟内有效）。" % (
                        p["cmd"], p["reason"], cfg_int("confirm_timeout", 600) // 60)
        for m in self.history:
            m.pop("reasoning_content", None)
        return "这件事步骤太多，我先停在这里了。你可以说「继续」让我接着查。"

    def tool(self, call):
        fn = call.get("function", {})
        try:
            a = json.loads(fn.get("arguments") or "{}")
        except ValueError:
            return "参数不是合法 JSON"
        name = fn.get("name")
        if name == "github_api" and gh_on():
            method = (a.get("method") or "GET").upper()
            path, reason = (a.get("path") or "").strip(), (a.get("reason") or "").strip()
            log("GitHub %s %s" % (method, path))
            if method != "DELETE":
                return run_gh(method, path, a.get("body"))
            if self.pending:
                return "已有一条操作在等用户确认，请等用户回复后再提新的。"
            self.pending = {"cmd": "GitHub DELETE " + path, "reason": reason or "删除操作", "ts": time.time(), "gh": (method, path, a.get("body"))}
            return "[等待确认] 删除类 GitHub 操作已发给用户确认。在用户回复前不要再调用工具，直接简短说明你准备做什么。"
        if name == "cloudflare_api" and cf_on():
            method = (a.get("method") or "GET").upper()
            path, reason = (a.get("path") or "").strip(), (a.get("reason") or "").strip()
            log("Cloudflare %s %s" % (method, path))
            if method in ("GET", "POST"):
                return run_cf(method, path, a.get("body"))
            if self.pending:
                return "已有一条操作在等用户确认，请等用户回复后再提新的。"
            desc = "Cloudflare %s %s" % (method, path)
            if a.get("body"):
                desc += "\n" + redact(json.dumps(a.get("body"), ensure_ascii=False))[:1500]
            self.pending = {"cmd": desc, "reason": reason or "修改/删除 Cloudflare 配置", "ts": time.time(), "cf": (method, path, a.get("body"))}
            return "[等待确认] 修改/删除类 Cloudflare 操作已发给用户确认。在用户回复前不要再调用工具，直接简短说明你准备做什么。"
        if name == "web_search" and web_on():
            log("搜索：%s" % (a.get("query") or "")[:200])
            return run_search((a.get("query") or "").strip(), a.get("count"))
        if name == "web_fetch" and web_on():
            log("打开网页：%s" % (a.get("url") or "")[:300])
            return run_fetch((a.get("url") or "").strip(), a.get("max_chars"))
        if name not in ("run_command", "nas_command") or (name == "nas_command" and not nas_on()):
            return "没有这个工具"
        cmd, reason = (a.get("command") or "").strip(), (a.get("reason") or "").strip()
        if name == "nas_command":
            kind, why = classify_nas(cmd)
            try:
                to = max(10, min(int(a.get("timeout_sec") or 120), 1800))
            except (TypeError, ValueError):
                to = 120
            log("NAS 工具调用 [%s] %s" % (kind, cmd[:500]))
            if kind == "deny":
                return "已拒绝：" + why
            if kind == "ro":
                if to > 60:
                    try:
                        self.send("⏳ NAS 执行中（最长 %d 分钟）：%s" % ((to + 59) // 60, reason or cmd[:200]))
                    except Exception:
                        pass
                return run_nas(cmd, to)
            if self.pending:
                return "已有一条命令在等用户确认，请等用户回复后再提新的。"
            self.pending = {"cmd": cmd, "reason": reason or why, "ts": time.time(), "nas": True, "timeout": to}
            return "[等待确认] 这条 NAS 命令属于%s，已发给用户确认。在用户回复前不要再调用工具，直接简短说明你准备做什么。" % why
        kind, why = classify(cmd)
        log("工具调用 [%s] %s" % (kind, cmd))
        if kind == "deny":
            return "已拒绝：" + why
        if kind == "ro":
            return run_shell(cmd, 30)
        if CFG.get("router_auto", "0") == "1":
            log("路由器改动免确认，直接执行（%s）" % why)
            return run_shell(cmd, 300)
        if self.pending:
            return "已有一条命令在等用户确认，请等用户回复后再提新的改动。"
        self.pending = {"cmd": cmd, "reason": reason or why, "ts": time.time()}
        return "[等待确认] 这条命令会改动系统（%s），已发给用户确认。在用户回复前不要再调用工具，直接简短说明你准备做什么。" % why

    def handle(self, text):
        try:
            return self._handle(text)
        finally:
            self.save()

    def _handle(self, text):
        t = text.strip()
        low = t.lower()
        if low in ("/help", "帮助", "help"):
            return HELP
        if low in ("/new", "新对话", "/reset"):
            self.history, self.pending = [], None
            return "好的，已清空对话记录。"
        if low in ("/status", "状态"):
            return quick_status()
        if self.pending:
            p = self.pending
            expired = time.time() - p["ts"] > cfg_int("confirm_timeout", 600)
            if not expired and low in ("确认", "确定", "执行", "是", "好", "y", "yes", "ok", "同意", "可以"):
                self.pending = None
                log("用户确认执行：", p["cmd"])
                out = run_cf(*p["cf"]) if p.get("cf") else run_gh(*p["gh"]) if p.get("gh") else run_nas(p["cmd"], p.get("timeout", 120)) if p.get("nas") else run_shell(p["cmd"], 120)
                self.send("✅ 已执行%s：%s\n%s" % ("（NAS）" if p.get("nas") else "", p["cmd"], out[:3000]))
                return self.think("[系统] 我已确认，命令「%s」执行结果如下，请简要说明结果，需要的话继续：\n%s" % (p["cmd"], out))
            if low in ("取消", "不要", "否", "n", "no", "算了", "别"):
                self.pending = None
                return self.think("[系统] 我拒绝执行「%s」。不要再执行它，简短回复即可。" % p["cmd"])
            self.pending = None
            if expired:
                t = "[系统] 上一条待确认命令已过期作废。\n" + t
            else:
                t = "[系统] 我没有确认上一条命令「%s」，它已作废。\n%s" % (p["cmd"], t)
        return self.think(t)


def quick_status():
    def rd(p):
        try:
            with open(p) as f:
                return f.read()
        except OSError:
            return ""
    out = []
    up = float((rd("/proc/uptime").split() or ["0"])[0])
    d, h, m = int(up // 86400), int(up % 86400 // 3600), int(up % 3600 // 60)
    out.append("⏱ 已运行 %s%d 小时 %d 分" % (("%d 天 " % d) if d else "", h, m))
    la = rd("/proc/loadavg").split()
    if la:
        out.append("📈 负载 %s / %s / %s（1/5/15 分钟，4 核）" % tuple(la[:3]))
    mi = {}
    for line in rd("/proc/meminfo").splitlines():
        k, _, v = line.partition(":")
        mi[k] = int((v.split() or ["0"])[0])
    if mi.get("MemTotal"):
        tot, av = mi["MemTotal"] // 1024, mi.get("MemAvailable", 0) // 1024
        out.append("🧠 内存 已用 %d MB / 共 %d MB，可用 %d MB（%d%%）" % (tot - av, tot, av, av * 100 // tot))
    try:
        st = os.statvfs("/overlay")
        tot, fr = st.f_blocks * st.f_frsize, st.f_bavail * st.f_frsize
        out.append("💾 存储 已用 %.1f GB / 共 %.1f GB，剩 %.1f GB" % ((tot - fr) / 1e9, tot / 1e9, fr / 1e9))
    except OSError:
        pass
    t = rd("/sys/class/thermal/thermal_zone0/temp").strip()
    if t.isdigit():
        c = int(t) / 1000
        out.append("🌡 CPU 温度 %.1f °C%s" % (c, "（偏高）" if c >= 70 else ""))
    return "\n".join(out) or "读不到系统状态"


HELP = """我是 N1 运维助手，直接用大白话问我就行，比如：
· 路由器现在负载、温度、内存怎么样
· AdGuard 今天拦截了多少
· 看看 cloudflared 最近的日志有没有报错
· 重启一下 AdGuard Home（会先问你确认）
· 在 NAS 上用 docker 跑一个 xxx 并告诉我访问地址（设置了 NAS 才有）
快捷指令：
· 状态 —— 直接看负载/内存/磁盘/温度（不走 AI）
· 新对话 —— 清空上下文
· 帮助 —— 显示这段话
安全规则：只读命令直接执行；会改动系统的命令先发给你，回复「确认」才执行；刷机、清盘之类高危命令一律拒绝。NAS 上默认改动直接做，格式化/清盘先问你。"""


# ---------------------------------------------------------------- 长连接主循环
class Bot:
    def __init__(self):
        self.agent = Agent()
        self.seen = {}
        self.ws = None
        self.service_id = 0
        self.ping_interval = 120

    def endpoint(self):
        j = http_json(FEISHU + "/callback/ws/endpoint", {"AppID": CFG.get("app_id"), "AppSecret": CFG.get("app_secret")},
                      {"locale": "zh"})
        if j.get("code") != 0:
            raise RuntimeError("获取长连接地址失败：%s %s" % (j.get("code"), j.get("msg")))
        d = j["data"]
        cc = d.get("ClientConfig") or {}
        self.ping_interval = int(cc.get("PingInterval") or 120)
        return d["URL"]

    async def run(self):
        import websockets
        delay = 5
        loop = asyncio.get_running_loop()
        while True:
            try:
                set_state(state="connecting", error="")
                url = await loop.run_in_executor(None, self.endpoint)
                self.service_id = int(parse_qs(urlparse(url).query).get("service_id", ["0"])[0])
                kw = {"max_size": 8 * 1024 * 1024}
                if "proxy" in inspect.signature(websockets.connect).parameters:
                    kw["proxy"] = None
                async with websockets.connect(url, **kw) as ws:
                    self.ws = ws
                    log("已连上飞书长连接")
                    set_state(state="online", online_since=int(time.time()), error="")
                    delay = 5
                    pinger = asyncio.ensure_future(self.ping_loop())
                    try:
                        async for raw in ws:
                            if isinstance(raw, (bytes, bytearray)):
                                asyncio.ensure_future(self.on_frame(raw))
                    finally:
                        pinger.cancel()
                log("长连接断开，准备重连")
            except Exception as e:
                log("连接出错：", e)
                set_state(state="error", error=str(e)[:300])
            self.ws = None
            await asyncio.sleep(delay)
            delay = min(delay * 2, 120)

    async def ping_loop(self):
        while True:
            try:
                await self.ws.send(frame_encode({"service": self.service_id, "method": 0, "headers": [["type", "ping"]]}))
            except Exception as e:
                log("ping 失败：", e)
            await asyncio.sleep(self.ping_interval)

    async def on_frame(self, raw):
        try:
            f = frame_decode(raw)
        except Exception as e:
            log("帧解析失败：", e)
            return
        typ = hget(f, "type")
        if f["method"] == 0:
            if typ == "pong" and f["payload"]:
                try:
                    self.ping_interval = int(json.loads(f["payload"]).get("PingInterval") or self.ping_interval)
                except ValueError:
                    pass
            return
        # 数据帧：先回 200 确认，避免飞书重推
        payload = f["payload"]
        s = int(hget(f, "sum") or 1)
        if s > 1:
            mid, seq = hget(f, "message_id"), int(hget(f, "seq") or 0)
            buf = self.seen.setdefault("part:" + mid, [None] * s)
            buf[seq] = payload
            if any(x is None for x in buf):
                return
            payload = b"".join(buf)
            self.seen.pop("part:" + mid, None)
        ack = dict(f)
        ack["headers"] = f["headers"] + [["biz_rt", "0"]]
        ack["payload"] = json.dumps({"code": 200}).encode()
        try:
            await self.ws.send(frame_encode(ack))
        except Exception as e:
            log("回执发送失败：", e)
        if typ != "event":
            return
        try:
            ev = json.loads(payload)
        except ValueError:
            return
        await self.on_event(ev)

    async def on_event(self, ev):
        h = ev.get("header", {})
        eid = h.get("event_id", "")
        now = time.time()
        if eid in self.seen:
            return
        self.seen[eid] = now
        if len(self.seen) > 500:
            for k in [k for k, v in self.seen.items() if isinstance(v, float) and now - v > 3600]:
                self.seen.pop(k, None)
        if h.get("event_type") != "im.message.receive_v1":
            log("忽略事件", h.get("event_type"))
            return
        e = ev.get("event", {})
        msg = e.get("message", {})
        sender = e.get("sender", {}).get("sender_id", {}).get("open_id", "")
        if msg.get("chat_type") != "p2p" or not sender:
            return
        chat = msg.get("chat_id", "") or sender
        set_state(last_event=int(now))
        loop = asyncio.get_running_loop()
        owner = CFG.get("owner_open_id", "")
        if not owner:
            name = await loop.run_in_executor(None, feishu_user_name, sender)
            CFG["owner_open_id"], CFG["owner_name"] = sender, name
            uci_set("owner_open_id", sender)
            CFG["owner_chat_id"] = chat
            uci_set("owner_chat_id", chat)
            if name:
                uci_set("owner_name", name)
            set_state(owner=name or sender)
            log("已绑定主人：", name or sender)
            await loop.run_in_executor(None, feishu_send, chat, "你好%s，已把你绑定为这台路由器的主人，以后只听你的。\n\n%s" % (
                ("，" + name) if name else "", HELP))
            return
        if sender != owner:
            log("拒绝陌生人消息：", sender)
            await loop.run_in_executor(None, feishu_send, chat, "抱歉，我只为这台路由器的主人服务。")
            return
        if chat.startswith("oc_") and CFG.get("owner_chat_id") != chat:
            CFG["owner_chat_id"] = chat
            uci_set("owner_chat_id", chat)
        if msg.get("message_type") != "text":
            await loop.run_in_executor(None, feishu_send, chat, "目前只看得懂文字消息。")
            return
        try:
            text = json.loads(msg.get("content") or "{}").get("text", "")
        except ValueError:
            text = ""
        text = re.sub(r"@_user_\d+", "", text).strip()
        if not text:
            return
        log("收到：", text[:200])
        async with self.agent.lock:
            try:
                reply = await loop.run_in_executor(None, self.agent.handle, text)
            except Exception as ex:
                log("处理出错：", ex)
                reply = "出错了：%s" % ex
            await loop.run_in_executor(None, feishu_send, chat, reply)


# ---------------------------------------------------------------- 自检（LuCI「测试连接」）
def selftest():
    res = {"feishu": "", "llm": "", "websockets": ""}
    try:
        import websockets  # noqa
        res["websockets"] = "ok " + getattr(websockets, "__version__", "")
    except Exception as e:
        res["websockets"] = "缺少 python3-websockets：%s" % e
    try:
        feishu_token()
        res["feishu"] = "ok"
        try:
            Bot().endpoint()
            res["feishu"] = "ok（长连接地址获取成功）"
        except Exception as e:
            res["feishu"] = "令牌正常，但长连接：%s" % e
    except Exception as e:
        res["feishu"] = str(e)
    try:
        url = CFG.get("base_url", "https://api.deepseek.com").rstrip("/") + "/chat/completions"
        j = http_json(url, {"model": CFG.get("model") or "deepseek-flash", "max_tokens": 5,
                            "messages": [{"role": "user", "content": "回复 ok"}]},
                      {"Authorization": "Bearer " + CFG.get("api_key", "")}, timeout=60)
        if "choices" in j:
            res["llm"] = "ok（%s）" % j.get("model", "")
        else:
            err = j.get("error", {})
            res["llm"] = "失败：%s %s" % (j.get("http_status", ""), err.get("message") if isinstance(err, dict) else j)
    except Exception as e:
        res["llm"] = "失败：%s" % e
    if gh_on():
        try:
            j = gh_call("GET", "/user")
            res["github"] = ("ok（%s）" % j["login"]) if j.get("login") else "失败：%s %s" % (j.get("http_status", ""), j.get("message", ""))
        except Exception as e:
            res["github"] = "失败：%s" % e
    if cf_on():
        try:
            j = cf_call("GET", "/zones?per_page=50")
            res["cloudflare"] = ("ok（%s）" % "、".join(z["name"] for z in j["result"])) if j.get("success") else "失败：%s" % (j.get("errors") or j)
        except Exception as e:
            res["cloudflare"] = "失败：%s" % e
    if web_on():
        try:
            r, _ = search("OpenWrt", 3)
            res["search"] = ("ok（%s，%d 条）" % ("Tavily" if CFG.get("search_engine") == "tavily" and CFG.get("tavily_key") else "必应", len(r))) if r else "失败：没有解析到结果"
        except Exception as e:
            res["search"] = "失败：%s" % e
    if nas_on():
        out = run_nas("echo NAS_OK $(hostname)", 20)
        res["nas"] = ("ok（%s）" % out.split("NAS_OK", 1)[1].strip()) if "NAS_OK" in out else "连不上：" + out.replace("退出码: ", "")[:200]
    print(json.dumps(res, ensure_ascii=False))


def main():
    load_cfg()
    if len(sys.argv) > 1 and sys.argv[1] == "--test":
        return selftest()
    if len(sys.argv) > 2 and sys.argv[1] == "--classify":
        print(classify(" ".join(sys.argv[2:])))
        return
    collect_secrets()
    bot = Bot()
    try:
        bot.agent.board = subprocess.run(["sh", "-c", "ubus call system board | jsonfilter -e '@.model' -e '@.release.description' 2>/dev/null | tr '\\n' ' '"],
                                         capture_output=True, text=True, timeout=10).stdout.strip() or "斐讯 N1"
    except Exception:
        bot.agent.board = "斐讯 N1"
    set_state(state="starting", owner=CFG.get("owner_name") or CFG.get("owner_open_id", ""), error="")
    log("AI 运维助手 %s 启动，模型 %s" % (VERSION, CFG.get("model")))
    asyncio.run(bot.run())


if __name__ == "__main__":
    main()
