import json, subprocess, sys, time, threading, queue, os
codex = "/tmp/codexsmoke/codex-x86_64-unknown-linux-musl"
env = dict(os.environ, CODEX_HOME="/tmp/codexsmoke/home")
for k in ("OPENAI_API_KEY","CODEX_API_KEY","CODEX_ACCESS_TOKEN"): env.pop(k, None)
os.makedirs(env["CODEX_HOME"], exist_ok=True)
p = subprocess.Popen([codex, "app-server", "--listen", "stdio://"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, bufsize=1)
q = queue.Queue()
threading.Thread(target=lambda: [q.put(l) for l in p.stdout], daemon=True).start()
log = open(sys.argv[1], "w")
def send(m):
    log.write(">> " + json.dumps(m) + "\n"); p.stdin.write(json.dumps(m) + "\n"); p.stdin.flush()
def drain(until_id=None, timeout=15):
    end = time.time() + timeout; got = None
    while time.time() < end:
        try: l = q.get(timeout=0.5)
        except queue.Empty: continue
        log.write("<< " + l.strip() + "\n")
        m = json.loads(l)
        if until_id is not None and m.get("id") == until_id and ("result" in m or "error" in m): return m
    return got
send({"method":"account/read","id":99,"params":{}}); drain(99, 5)   # before initialize -> expect error
send({"method":"initialize","id":0,"params":{"clientInfo":{"name":"dottie_week1_probe","title":"Dottie Week-1 Probe","version":"0.0.1"}}})
drain(0)
send({"method":"initialized","params":{}})
send({"method":"account/read","id":1,"params":{"refreshToken":False}}); drain(1)
r = None
send({"method":"account/login/start","id":2,"params":{"type":"chatgpt"}}); r = drain(2)
lid = (r or {}).get("result",{}).get("loginId")
if lid:
    send({"method":"account/login/cancel","id":3,"params":{"loginId":lid}}); drain(3); drain(None, 3)
send({"method":"account/read","id":4,"params":{}}); drain(4)
send({"method":"thread/start","id":5,"params":{"cwd":"/tmp/codexsmoke/ws","ephemeral":True}}); r = drain(5, 30)
tid = (r or {}).get("result",{}).get("thread",{}).get("id")
if tid:
    send({"method":"turn/start","id":6,"params":{"threadId":tid,"input":[{"type":"text","text":"Reply with the word OK."}]}}); drain(6, 20); drain(None, 25)
send({"method":"account/logout","id":7}); drain(7); drain(None, 3)
p.stdin.close(); p.terminate(); p.wait(5)
log.write("## exit %s\n## stderr:\n%s\n" % (p.returncode, p.stderr.read()[-4000:]))
