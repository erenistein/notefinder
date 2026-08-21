"""
Arka plan is mekanizmasi: bellek-ici registry + SQLite kalicilik + ThreadPoolExecutor.
Uzun isler (OMR ~6dk, transcribe ~3dk) bloklamadan calisir; frontend job-status ile sorgular.
"""
import os
import sqlite3
import json
import time
import threading
from concurrent.futures import ThreadPoolExecutor

OUTPUT_DIR = "outputs"
JOBS_DB = os.path.join(OUTPUT_DIR, "jobs.db")

_executor = ThreadPoolExecutor(max_workers=2)  # simdilik 2; ileride Celery
_lock = threading.Lock()
_mem = {}  # job_id -> dict (bellek-ici registry)


def _conn():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    c = sqlite3.connect(JOBS_DB, check_same_thread=False)
    # ticker(3sn)+prog+runner ayni DB'ye ayri baglantidan yazar -> kilitte hata yerine bekle
    c.execute("PRAGMA busy_timeout=5000")
    c.execute(
        "CREATE TABLE IF NOT EXISTS jobs("
        "job_id TEXT PRIMARY KEY, kind TEXT, status TEXT, progress INTEGER, message TEXT, "
        "result_json TEXT, error TEXT, created_at REAL, updated_at REAL)"
    )
    return c


def init_jobs():
    """Backend acilista: running/queued kalanlari failed'a cevir (yarim kalmis isler)."""
    c = _conn()
    try:
        c.execute(
            "UPDATE jobs SET status='failed', error=?, message='Hata', updated_at=? "
            "WHERE status IN ('running','queued')",
            ("Sunucu yeniden basladi, tekrar deneyin.", time.time()),
        )
        c.commit()
    finally:
        c.close()


def create_job(job_id, kind):
    now = time.time()
    row = {"job_id": job_id, "kind": kind, "status": "queued", "progress": 0,
           "message": "Sirada", "result": None, "error": None,
           "created_at": now, "updated_at": now}
    with _lock:
        _mem[job_id] = row
    c = _conn()
    try:
        c.execute("INSERT OR REPLACE INTO jobs(job_id,kind,status,progress,message,result_json,error,created_at,updated_at) "
                  "VALUES(?,?,?,?,?,?,?,?,?)",
                  (job_id, kind, "queued", 0, "Sirada", None, None, now, now))
        c.commit()
    finally:
        c.close()
    return dict(row)


def update_job(job_id, **kw):
    now = time.time()
    with _lock:
        row = _mem.get(job_id)
        if row is None:
            return
        row.update(kw)
        row["updated_at"] = now
        snap = dict(row)
    # DB yazimi BEST-EFFORT: _mem zaten canli durumun tek dogru kaynagi. Gecici bir SQLite
    # kilidi/hatasi ASLA gercek isi (prog uzerinden) failed'a dusurmesin.
    try:
        c = _conn()
        try:
            c.execute("UPDATE jobs SET status=?, progress=?, message=?, result_json=?, error=?, updated_at=? WHERE job_id=?",
                      (snap["status"], int(snap["progress"]), snap["message"],
                       json.dumps(snap["result"]) if snap["result"] is not None else None,
                       snap["error"], now, job_id))
            c.commit()
        finally:
            c.close()
    except Exception as e:
        print(f"jobs.update_job DB yazimi atlandi ({job_id}): {e}")


def get_job(job_id):
    with _lock:
        if job_id in _mem:
            return dict(_mem[job_id])
    # bellekte yoksa (restart sonrasi) DB'den
    c = _conn()
    try:
        r = c.execute("SELECT job_id,kind,status,progress,message,result_json,error,created_at,updated_at "
                      "FROM jobs WHERE job_id=?", (job_id,)).fetchone()
    finally:
        c.close()
    if not r:
        return None
    return {"job_id": r[0], "kind": r[1], "status": r[2], "progress": r[3], "message": r[4],
            "result": json.loads(r[5]) if r[5] else None, "error": r[6],
            "created_at": r[7], "updated_at": r[8]}


def submit(job_id, fn):
    """fn(prog) -> result dict. prog(pct, msg=None) ile ilerleme bildirir. Kuyruga atar."""
    def runner():
        update_job(job_id, status="running", progress=1, message="Basladi")

        def prog(pct, msg=None):
            kw = {"progress": max(1, min(100, int(pct)))}
            if msg:
                kw["message"] = msg
            update_job(job_id, **kw)

        try:
            result = fn(prog)
            update_job(job_id, status="done", progress=100, message="Tamam", result=result)
        except Exception as e:
            detail = getattr(e, "detail", None) or str(e)
            update_job(job_id, status="failed", error=str(detail)[:400], message="Hata")

    _executor.submit(runner)


def make_ticker(job_id, est, lo=15, hi=85):
    """Uzun (subprocess) is icin zaman-tabanli kaba ilerleme: prog'u lo->hi arasi ilerletir.
    Yalniz mevcut ilerleme [lo, hi) araligindayken artirir. Doner: stop() cagrisi."""
    stop = threading.Event()

    def run():
        start = time.monotonic()
        while not stop.wait(3):
            j = get_job(job_id)
            if not j or j["status"] != "running":
                break
            cur = j["progress"]
            if cur < lo or cur >= hi:
                continue  # oemer/transcribe henuz baslamadi ya da asama gecti
            el = time.monotonic() - start
            pct = min(hi - 1, lo + int((el / max(1, est)) * (hi - lo)))
            if pct > cur:
                update_job(job_id, progress=pct)

    threading.Thread(target=run, daemon=True).start()
    return stop.set
