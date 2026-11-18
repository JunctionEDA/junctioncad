#!/usr/bin/env python3
"""Desktop sweep: every demo project goes to a local test server, is opened with the desktop's
own Open button, loaded in both editors and read by kicad-cli; whatever the app says is recorded.

Variants per demo: "desktop" (the files the desktop uploads), "web" (design files and library
tables only, as a browser upload without library folders), "edited" (uploaded, then touched in
the web editor by webedit.mjs before it is opened).

Everything lives in SWEEP_OUT; test instances get their own settings, documents and cache
folders and a test sign-in, and are killed by pid.  See README.md for the environment."""
import io, json, os, re, signal, subprocess, sys, time, zipfile, urllib.request, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
E2E = os.environ["SWEEP_OUT"]
APP = os.path.join(os.environ["JUNCTION_APP"], "Contents", "MacOS")
SERVER = os.environ.get("SWEEP_SERVER", "http://127.0.0.1:8125").rstrip("/")
TOKEN = os.environ["SWEEP_TOKEN"]
AX = os.path.join(E2E, "bin", "ax")
WINS = os.path.join(E2E, "bin", "wins")
DOCS = f"{E2E}/docs"
CLOUD = f"{DOCS}/KiCad/10.99/projects/Cloud"
ENV = dict(os.environ, KICAD_CONFIG_HOME=f"{E2E}/config", KICAD_DOCUMENTS_HOME=DOCS, KICAD_CACHE_HOME=f"{E2E}/cache",
           KICAD_COLLAB_SERVER=SERVER, KICAD_COLLAB_TOKEN=TOKEN)
WANT_EXT = {"kicad_pro", "kicad_sch", "kicad_pcb", "kicad_sym", "kicad_mod", "kicad_dru", "kicad_wks",
            "step", "stp", "wrl", "wrz", "lib", "sub", "cir", "mod", "spice", "ibs"}
TABLES = {"sym-lib-table", "fp-lib-table", "design-block-lib-table"}
BAD = re.compile(r"error|not found|could not|couldn't|cannot|can't|failed|expecting|unable|missing|invalid|warning", re.I)


def project_files(pdir, web):
    out = []
    for root, dirs, files in os.walk(pdir):
        rel_dirs = os.path.relpath(root, pdir).split(os.sep)
        if any(d.endswith(".collab") or d.endswith("-backups") or (d.startswith(".") and d != ".") for d in rel_dirs):
            continue
        for f in files:
            ext = f.rsplit(".", 1)[-1].lower() if "." in f else ""
            if web:
                ok = ext in ("kicad_pro", "kicad_sch", "kicad_pcb") or f in TABLES
            else:
                ok = ext in WANT_EXT or f in TABLES
            if ok:
                full = os.path.join(root, f)
                out.append((os.path.relpath(full, pdir).replace(os.sep, "/"), full))
    return out


def post_multipart(parts):
    b = uuid.uuid4().hex
    body = io.BytesIO()
    for name, filename, ctype, data in parts:
        body.write(f"--{b}\r\nContent-Disposition: form-data; name=\"{name}\"".encode())
        if filename is not None:
            body.write(f"; filename=\"{filename}\"".encode())
        body.write(b"\r\n")
        if ctype:
            body.write(f"Content-Type: {ctype}\r\n".encode())
        body.write(b"\r\n" + data + b"\r\n")
    body.write(f"--{b}--\r\n".encode())
    req = urllib.request.Request(f"{SERVER}/api/projects", data=body.getvalue(), method="POST",
                                 headers={"Authorization": f"Bearer {TOKEN}",
                                          "Content-Type": f"multipart/form-data; boundary={b}"})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")[:400]
    except urllib.error.URLError as e:
        return 0, f"no HTTP answer: {e.reason}"


def upload(pdir, name, web):
    files = project_files(pdir, web)
    if web:
        parts = [("name", None, None, name.encode())]
        parts += [("file", rel, "application/octet-stream", open(full, "rb").read()) for rel, full in files]
    else:
        mem = io.BytesIO()
        with zipfile.ZipFile(mem, "w", zipfile.ZIP_DEFLATED) as z:
            for rel, full in files:
                z.write(full, rel)
        parts = [("archive", "project.zip", "application/zip", mem.getvalue()), ("name", None, None, name.encode())]
    return post_multipart(parts), len(files)


def ax(pid, *args):
    return subprocess.run([AX, str(pid), *args], capture_output=True, text=True, timeout=60).stdout


def windows(pid):
    """[(title, [texts])] from the ax dump."""
    wins, cur = [], None
    for line in ax(pid, "dump").splitlines():
        s = line.strip()
        role, _, rest = s.partition("|")
        if role == "AXWindow" or role == "AXSheet":
            cur = (rest.split("|")[0], [])
            wins.append(cur)
        elif cur is not None and role == "AXStaticText":
            t = rest.split("|")[1] if rest.count("|") >= 1 else rest
            if t:
                cur[1].append(t)
    return wins


def shot(pid, path):
    out = subprocess.run([WINS, str(pid)], capture_output=True, text=True).stdout
    for line in out.splitlines():
        p = line.split()
        if len(p) >= 4 and p[-3] == "1" and float(p[-1]) > 300:
            subprocess.run(["screencapture", "-x", "-l", p[0], path])
            subprocess.run(["sips", "-Z", "1400", path, "--out", path], capture_output=True)
            return


def close_dialogs(pid, main_hint, found, rounds=6):
    """Record and dismiss every window that is not the main one."""
    for _ in range(rounds):
        extra = [w for w in windows(pid) if main_hint not in w[0]]
        if not extra:
            return
        for title, texts in extra:
            found.append({"dialog": title, "text": " / ".join(texts)[:1500]})
        for b in ("OK", "Close", "Cancel", "No", "Dismiss"):
            if "press 0" in ax(pid, "press", b):
                break
        time.sleep(1.5)


def launch(args, log):
    return subprocess.Popen([f"{APP}/Junction" if os.path.exists(f"{APP}/Junction") else f"{APP}/kicad", *args], env=ENV, stdout=open(log, "w"), stderr=subprocess.STDOUT)


def editor(frame, path, tag, res):
    stem = os.path.splitext(os.path.basename(path))[0]
    log = f"{E2E}/logs/{tag}-{frame}.log"
    p = launch(["--frame", frame, path], log)
    found, t0, seen = [], time.time(), False
    try:
        while time.time() - t0 < 75:
            time.sleep(3)
            ws = windows(p.pid)
            if any(w[0] and stem not in w[0] for w in ws):   # a dialog is up
                close_dialogs(p.pid, stem, found)
            if any(stem in w[0] for w in ws):
                if seen:
                    break
                seen = True
        time.sleep(4)
        close_dialogs(p.pid, stem, found)
        ws = windows(p.pid)
        main = [w for w in ws if stem in w[0]]
        infobar = [t for w in main for t in w[1] if BAD.search(t) and len(t) > 25]
        shot(p.pid, f"{E2E}/shots/{tag}-{frame}.png")
        res[frame] = {"opened": bool(main), "modified_on_open": any(w[0].startswith("*") for w in main), "dialogs": found, "infobar": infobar[:8], "secs": round(time.time() - t0)}
    finally:
        p.kill()
        p.wait()
    errs = [l for l in open(log, errors="replace").read().splitlines() if BAD.search(l)]
    if errs:
        res[frame]["stderr"] = errs[:8]


def cli(args):
    r = subprocess.run([f"{APP}/kicad-cli", *args], env=ENV, capture_output=True, text=True, timeout=600)
    lines = [l for l in (r.stdout + r.stderr).splitlines() if BAD.search(l)]
    return {"exit": r.returncode, "msgs": lines[:8]}


def main():
    only = sys.argv[1:]
    pros = []
    for root, dirs, files in os.walk(f"{REPO}/demos"):
        for f in sorted(files):
            if f.endswith(".kicad_pro"):
                pros.append(os.path.join(root, f))
    pros.sort()
    if only:
        pros = [p for p in pros if any(o in p for o in only)]
    os.makedirs(f"{E2E}/logs", exist_ok=True); os.makedirs(f"{E2E}/shots", exist_ok=True)
    results_path = f"{E2E}/results.jsonl"
    done = {json.loads(l)["name"] for l in open(results_path)} if os.path.exists(results_path) else set()

    mgr = launch([f"{E2E}/blank/blank.kicad_pro"], f"{E2E}/logs/manager.log")
    time.sleep(10)
    try:
        for pro in pros:
            stem = os.path.splitext(os.path.basename(pro))[0]
            for variant in os.environ.get("VARIANTS", "desktop,web").split(","):
                name = f"{stem}-{variant[0]}"
                if name in done:
                    continue
                res = {"name": name, "project": os.path.relpath(pro, f"{REPO}/demos"), "variant": variant}
                (status, body), nfiles = upload(os.path.dirname(pro), name, variant == "web")
                res["upload"] = {"status": status, "files": nfiles}
                if status != 200 and status != 201:
                    res["upload"]["error"] = body if isinstance(body, str) else json.dumps(body)[:300]
                    open(results_path, "a").write(json.dumps(res) + "\n"); print(json.dumps(res), flush=True)
                    continue
                if variant == "edited":
                    try:
                        w = subprocess.run(["node", os.path.join(HERE, "webedit.mjs"), body["projectId"]], env=ENV, capture_output=True, text=True, timeout=600)
                        res["webedit"] = json.loads(w.stdout.strip().splitlines()[-1]) if w.stdout.strip() else {"error": w.stderr[-400:]}
                    except Exception as e:
                        res["webedit"] = {"error": str(e)[:300]}
                if isinstance(body, dict) and body.get("skipped"):
                    res["upload"]["skipped"] = body["skipped"][:10]
                # The desktop's own Open: refresh the list by restarting the manager's view is not
                # scriptable, so reopen the pane data with a manager restart every upload.
                mgr.kill(); mgr.wait()
                mgr = launch([f"{E2E}/blank/blank.kicad_pro"], f"{E2E}/logs/manager.log")
                time.sleep(9)
                found = []
                sel = ax(mgr.pid, "selectrow", name)
                pr = ax(mgr.pid, "press", "Open")
                target = f"{CLOUD}/{name}"
                t0 = time.time()
                while time.time() - t0 < 60:
                    time.sleep(2)
                    ws = windows(mgr.pid)
                    extra = [w for w in ws if "Junction 2." not in w[0]]
                    if extra:
                        close_dialogs(mgr.pid, "Junction 2.", found)
                    if os.path.isdir(target) and not any("blank" in w[0] for w in ws):
                        break
                time.sleep(2)
                close_dialogs(mgr.pid, "Junction 2.", found)
                res["open"] = {"select": sel.strip(), "press": pr.strip(), "dialogs": found,
                               "extracted": os.path.isdir(target), "secs": round(time.time() - t0)}
                shot(mgr.pid, f"{E2E}/shots/{name}-manager.png")
                if os.path.isdir(target):
                    res["files"] = sorted(os.path.relpath(os.path.join(r, f), target)
                                          for r, d, fs in os.walk(target) for f in fs if ".collab" not in r)[:60]
                    # The archive may hold several projects' files (a folder with two .kicad_pro).
                    sch = f"{target}/{stem}.kicad_sch"; pcb = f"{target}/{stem}.kicad_pcb"
                    if os.path.exists(sch):
                        res["cli_sch"] = cli(["sch", "export", "netlist", "-o", f"{E2E}/out/{name}.net", sch])
                        editor("sch", sch, name, res)
                    if os.path.exists(pcb):
                        res["cli_pcb"] = cli(["pcb", "export", "svg", "--layers", "F.Cu,Edge.Cuts", "-o", f"{E2E}/out/{name}.svg", pcb])
                        res["cli_drc"] = cli(["pcb", "drc", "-o", f"{E2E}/out/{name}.drc", pcb])
                        try:
                            rpt = open(f"{E2E}/out/{name}.drc", errors="replace").read()
                            kinds = {}
                            for m in re.finditer(r"^\[(\w+)\]: (.*)$", rpt, re.M):
                                if m.group(1).startswith("lib_"):
                                    k = re.sub(r"'[^']*'", "'…'", m.group(2), count=1) if "not found in library" in m.group(2) else m.group(2)
                                    kinds[k] = kinds.get(k, 0) + 1
                            res["drc_lib"] = kinds
                        except OSError:
                            pass
                        editor("pcb", pcb, name, res)
                open(results_path, "a").write(json.dumps(res) + "\n"); print(json.dumps(res), flush=True)
    finally:
        mgr.kill(); mgr.wait()


if __name__ == "__main__":
    for d in ("out", "blank", "bin"):
        os.makedirs(f"{E2E}/{d}", exist_ok=True)
    if not os.path.exists(f"{E2E}/blank/blank.kicad_pro"):
        open(f"{E2E}/blank/blank.kicad_pro", "w").write("{}\n")
    for tool in ("ax", "wins"):   # the two accessibility helpers, built once
        if not os.path.exists(f"{E2E}/bin/{tool}"):
            subprocess.run(["swiftc", "-O", os.path.join(HERE, f"{tool}.swift"), "-o", f"{E2E}/bin/{tool}"], check=True)
    subprocess.run([os.path.join(HERE, "preflight.sh"), os.environ["JUNCTION_APP"]], check=True)
    main()
