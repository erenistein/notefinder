"""
OMR gorsel cache: ayni/benzer nota fotografini tekrar isleme. SQLite + pHash.
- SHA-256 tam esleme (birebir ayni dosya).
- pHash (imagehash.phash, hash_size=16) Hamming mesafesi <= HAMMING_MAX (hafifce
  kirpilmis/yeniden boyutlanmis ayni sayfa). Tablo kucuk -> tam tarama yeter.
MusicXML'ler outputs/omr_cache/{sha256}.musicxml altinda kalici tutulur (job klasoru silinse de kalir).
"""
import os
import sqlite3
import hashlib
import shutil
import time
from PIL import Image
import imagehash

OUTPUT_DIR = "outputs"
CACHE_DB = os.path.join(OUTPUT_DIR, "omr_cache.db")
CACHE_MXL_DIR = os.path.join(OUTPUT_DIR, "omr_cache")
PHASH_SIZE = 16          # 16x16 = 256 bit
# Kalibre: 256-bit pHash'te mesafeler buyuk. Olculen: %5-kirp+0.9x varyant=66, farkli sayfa=118.
# Esik 80 -> varyant HIT (marj 14), farkli sayfa MISS (marj 38). SHA-256 zaten birebir kopyayi yakalar.
HAMMING_MAX = 80


def _conn():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    c = sqlite3.connect(CACHE_DB)
    c.execute(
        "CREATE TABLE IF NOT EXISTS omr_cache("
        "phash TEXT, sha256 TEXT PRIMARY KEY, musicxml_path TEXT, "
        "created_at REAL, hit_count INTEGER DEFAULT 0)"
    )
    return c


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def _phash(path):
    with Image.open(path) as im:
        return imagehash.phash(im.convert("L"), hash_size=PHASH_SIZE)


def lookup(image_path):
    """Cache'te var mi? Doner: (musicxml_path, matched_by, distance) veya (None, None, None).
    matched_by: 'sha256' (tam) veya 'phash' (benzer). Bulursa hit_count++."""
    c = _conn()
    try:
        sha = _sha256(image_path)
        row = c.execute("SELECT musicxml_path FROM omr_cache WHERE sha256=?", (sha,)).fetchone()
        if row and os.path.exists(row[0]):
            c.execute("UPDATE omr_cache SET hit_count=hit_count+1 WHERE sha256=?", (sha,))
            c.commit()
            return row[0], "sha256", 0
        ph = _phash(image_path)
        best = None  # (distance, sha256, mxl)
        for db_ph, db_sha, mxl in c.execute("SELECT phash, sha256, musicxml_path FROM omr_cache").fetchall():
            try:
                d = ph - imagehash.hex_to_hash(db_ph)
            except Exception:
                continue
            if d <= HAMMING_MAX and os.path.exists(mxl) and (best is None or d < best[0]):
                best = (d, db_sha, mxl)
        if best:
            c.execute("UPDATE omr_cache SET hit_count=hit_count+1 WHERE sha256=?", (best[1],))
            c.commit()
            return best[2], "phash", best[0]
        return None, None, None
    finally:
        c.close()


def store(image_path, musicxml_path):
    """OMR basarili -> MusicXML'i kalici cache klasorune kopyala + kaydet. Kalici yolu doner."""
    os.makedirs(CACHE_MXL_DIR, exist_ok=True)
    sha = _sha256(image_path)
    ph = str(_phash(image_path))
    dst = os.path.join(CACHE_MXL_DIR, sha + ".musicxml")
    if os.path.abspath(musicxml_path) != os.path.abspath(dst):
        shutil.copy2(musicxml_path, dst)
    c = _conn()
    try:
        c.execute(
            "INSERT OR REPLACE INTO omr_cache(phash, sha256, musicxml_path, created_at, hit_count) "
            "VALUES(?,?,?,?, COALESCE((SELECT hit_count FROM omr_cache WHERE sha256=?),0))",
            (ph, sha, dst, time.time(), sha),
        )
        c.commit()
    finally:
        c.close()
    return dst


def phash_distance(path_a, path_b):
    """Iki gorselin pHash Hamming mesafesi (kalibrasyon/tesih icin)."""
    return _phash(path_a) - _phash(path_b)
