#!/usr/bin/env python3
# 端到端模拟：假飞书（HTTP + 长连接）+ 假大模型，跑 agent.py 一遍
# 用法：python3 test/mock-agent.py   （需要 pip install websockets）
import asyncio, json, os, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import websockets
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "../root/usr/share/opsagent"))
import agent as A

SENT, LLM_CALLS = [], []
SCRIPT = [
    {"tool_calls": [{"id": "c1", "type": "function", "function": {"name": "run_command", "arguments": json.dumps({"command": "uptime", "reason": "看负载"})}}]},
    {"content": "负载很低。"},
    {"tool_calls": [{"id": "c2", "type": "function", "function": {"name": "run_command", "arguments": json.dumps({"command": "echo RESTART_OK > /tmp/opsagent-mock.txt; cat /tmp/opsagent-mock.txt", "reason": "重启服务"})}}]},
    {"content": "已重启完成。"},
]

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self): self.do_POST()
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        p = self.path
        if p.startswith("/callback/ws/endpoint"):
            r = {"code": 0, "data": {"URL": "ws://127.0.0.1:18081/ws?device_id=d1&service_id=9", "ClientConfig": {"PingInterval": 2}}}
        elif "tenant_access_token" in p:
            r = {"code": 0, "tenant_access_token": "t-x", "expire": 7200}
        elif p.startswith("/open-apis/im/v1/messages"):
            assert ("receive_id_type=chat_id" in p) == body["receive_id"].startswith("oc_"); SENT.append((body["receive_id"].replace("oc_", ""), json.loads(body["content"])["text"])); r = {"code": 0}
        elif p.startswith("/open-apis/contact"):
            r = {"code": 0, "data": {"user": {"name": "赵豆包"}}}
        elif p.endswith("/chat/completions"):
            LLM_CALLS.append(body)
            m = dict(SCRIPT[len(LLM_CALLS) - 1]); m["role"] = "assistant"
            r = {"choices": [{"message": m}], "model": "mock"}
        else:
            r = {"code": 404}
        d = json.dumps(r).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(d))); self.end_headers(); self.wfile.write(d)

def ev(i, oid, text):
    e = {"schema": "2.0", "header": {"event_id": "e%d" % i, "event_type": "im.message.receive_v1"},
         "event": {"sender": {"sender_id": {"open_id": oid}}, "message": {"message_id": "m%d" % i, "chat_id": "oc_" + oid, "chat_type": "p2p", "message_type": "text", "content": json.dumps({"text": text})}}}
    return A.frame_encode({"SeqID": i, "LogID": i, "service": 9, "method": 1, "headers": [["type", "event"], ["message_id", "x%d" % i], ["sum", "1"], ["seq", "0"], ["trace_id", "t"]], "payload": json.dumps(e).encode()})

ACKS, PINGS = [], []
async def ws_handler(ws, *a):
    async def reader():
        async for m in ws:
            f = A.frame_decode(m)
            (PINGS if f["method"] == 0 else ACKS).append(f)
    t = asyncio.ensure_future(reader())
    steps = [("ou_owner", "你好"), ("ou_owner", "你好"), ("ou_evil", "rm 一下"), ("ou_owner", "负载怎样"), ("ou_owner", "帮我重启"), ("ou_owner", "确认")]
    for i, (oid, txt) in enumerate(steps):
        await ws.send(ev(i if i != 1 else 0, oid, txt))  # 第 2 条重复 event_id，应被去重
        await asyncio.sleep(1.2)
    await asyncio.sleep(1); t.cancel()

async def main():
    srv = ThreadingHTTPServer(("127.0.0.1", 18080), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
    async with websockets.serve(ws_handler, "127.0.0.1", 18081):
        os.environ["OPSAGENT_FEISHU"] = "http://127.0.0.1:18080"
        A.FEISHU = "http://127.0.0.1:18080"
        A.CFG.update({"app_id": "a", "app_secret": "secretsecret", "api_key": "k", "base_url": "http://127.0.0.1:18080", "model": "m", "owner_open_id": ""})
        A.STATUS_FILE = "/tmp/opsagent-test.status"
        bot = A.Bot()
        task = asyncio.ensure_future(bot.run())
        await asyncio.sleep(10)
        task.cancel()
    for s in SENT: print("SENT", s[0], "|", s[1][:80].replace("\n", " / "))
    print("ACKS", len(ACKS), "PINGS", len(PINGS), "LLM", len(LLM_CALLS))
    assert SENT[0][0] == "ou_owner" and "绑定" in SENT[0][1]
    assert any(s[0] == "ou_evil" and "主人" in s[1] for s in SENT)
    assert any("负载很低" in s[1] for s in SENT)
    assert any("需要你确认" in s[1] for s in SENT)
    assert any("RESTART_OK" in s[1] for s in SENT)
    assert any("已重启完成" in s[1] for s in SENT)
    assert len(ACKS) == 6 and len(PINGS) >= 2 and len(LLM_CALLS) == 4
    roles = [m["role"] for m in LLM_CALLS[-1]["messages"]]
    print("roles", roles)
    print("状态文件", open("/tmp/opsagent-test.status").read())
    print("ALL OK")

asyncio.run(main())
