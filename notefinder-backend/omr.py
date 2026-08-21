"""
OMR koprusu: nota fotografi -> MusicXML (oemer) -> music21 -> MIDI -> notes.
Backend'in mevcut notes/generate_pdf zincirine baglanir (yeni format kodu YOK).

ONEMLI: oemer ANA VENV'DE CALISMAZ (numpy 2.x uyumsuzlugu: modelleri + bbox kodu
numpy 1.x istiyor). Bu yuzden oemer izole 'venv_omr' (numpy<2 + onnxruntime 1.17.3)
icinde subprocess ile calisir. music21/read_midi_notes ANA venv'de calisir.
"""
import os
import glob
import subprocess
from fastapi import HTTPException

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
OEMER_EXE = os.path.join(BACKEND_DIR, "venv_omr", "Scripts", "oemer.exe")
OUTPUT_DIR = "outputs"
OEMER_TIMEOUT = 900  # 15 dk
OMR_PREPROCESS = False  # preprocess() varsayilan KAPALI (kalite testinde faydasiz/zararli cikti); fonksiyon durur


# En kucuk kabul edilen kisa-kenar. NOT: spec 400 diyordu ama Kum Gibi ornegi 386 -> 350'ye
# dusuruldu ki gercek ama dusuk-res nota sayfalari gecsin (rapor: kalibrasyon sapmasi).
MIN_SIDE = 350
# Kenar-beyazlik esigi: gercek nota sayfasinin kenar bosluklari beyazdir (%96-100); UI ekran
# goruntusunde kenarlar koyu/kalabalik (Instagram: %29). span-yerine bu kullaniliyor (span
# temiz-ama-yarim-dolu sayfayi yanlis reddediyor + full-frame UI'yi yakalamiyordu).
EDGE_WHITE_MIN = 70.0


def staff_metrics(path):
    """Ucuz metrikler: (min_kenar, porte_cizgi_grubu_sayisi, kenar_beyazlik_yuzdesi).
    Porte: grayscale + adaptive threshold + yatay morfolojik acma (kernel = %40 genislik).
    Kenar beyazlik: dis %8 seridin g>200 orani (sayfa kenari mi UI mi)."""
    import cv2
    import numpy as np
    img = cv2.imread(path)
    if img is None:
        return None
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    # (b) yatay porte cizgileri
    bw = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 15, -2)
    kw = max(15, int(w * 0.4))
    hk = cv2.getStructuringElement(cv2.MORPH_RECT, (kw, 1))
    horiz = cv2.morphologyEx(bw, cv2.MORPH_OPEN, hk)
    line_rows = np.where((horiz > 0).sum(axis=1) > w * 0.3)[0]
    n_lines = 0
    if len(line_rows):
        n_lines = 1
        prev = line_rows[0]
        for r in line_rows[1:]:
            if r - prev > 3:
                n_lines += 1
            prev = r
    # (c) kenar beyazlik
    b = max(1, int(min(h, w) * 0.08))
    border = np.concatenate([gray[:b].ravel(), gray[-b:].ravel(), gray[:, :b].ravel(), gray[:, -b:].ravel()])
    edge_white = float((border > 200).mean() * 100.0)
    return (min(h, w), n_lines, edge_white)


def validate_sheet_image(path):
    """Kabul ONCESI ucuz kontrol. Kabul edilmezse anlamli Turkce HTTPException.
    (a) kisa kenar cok kucuk, (b) porte cizgisi <5, (c) kenarlar beyaz degil (UI/kirpilmamis)."""
    m = staff_metrics(path)
    if m is None:
        raise HTTPException(status_code=400, detail="Gorsel okunamadi.")
    min_side, n_lines, edge_white = m
    if min_side < MIN_SIDE:
        raise HTTPException(status_code=400, detail="Fotograf cok kucuk, daha net cekin.")
    NO_STAFF = ("Gorselde nota portesi bulunamadi. Lutfen sadece nota sayfasini kirpin; "
                "menu, yazi ve arayuz ogeleri olmasin.")
    if n_lines < 5:
        raise HTTPException(status_code=422, detail=NO_STAFF)
    if edge_white < EDGE_WHITE_MIN:  # kenarlar koyu/kalabalik -> UI ekran goruntusu / kirpilmamis
        raise HTTPException(status_code=422, detail=NO_STAFF)
    return True


def preprocess(image_path):
    """Opsiyonel OpenCV on-isleme (dusuk cozunurluk/kontrast icin).
    Genislik < 1500 ise 2x-3x upscale (INTER_CUBIC, hedef >=1500) + grayscale +
    hafif kontrast (CLAHE). Yeterince buyukse dokunmaz, orijinali doner.
    NOT: cv2 ana venv'de kurulu. Islenen kopya *_pre.png olarak yazilir."""
    try:
        import cv2
        img = cv2.imread(image_path)
        if img is None:
            return image_path
        h, w = img.shape[:2]
        if w >= 1500:
            return image_path  # yeterince yuksek cozunurluk -> dokunma
        scale = min(3.0, max(2.0, 1500.0 / w))
        img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_CUBIC)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        gray = clahe.apply(gray)
        out = os.path.splitext(image_path)[0] + "_pre.png"
        cv2.imwrite(out, gray)
        return out
    except Exception as e:
        print(f"OMR on-isleme atlandi: {e}")
        return image_path


def _run_oemer(image_path, out_dir):
    """oemer'i izole venv'de calistir; uretilen .musicxml yolunu doner."""
    if not os.path.exists(OEMER_EXE):
        raise HTTPException(status_code=500, detail="OMR motoru (oemer) kurulu degil.")
    os.makedirs(out_dir, exist_ok=True)
    try:
        result = subprocess.run(
            [OEMER_EXE, image_path, "-o", out_dir],
            capture_output=True, text=True, timeout=OEMER_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Nota tanima cok uzun surdu (zaman asimi). Daha kucuk/net bir foto deneyin.")
    base = os.path.splitext(os.path.basename(image_path))[0]
    mxl = os.path.join(out_dir, base + ".musicxml")
    if not os.path.exists(mxl) or os.path.getsize(mxl) < 50:
        detail = (result.stderr or "")[-300:]
        raise HTTPException(status_code=422, detail="Fotograftan nota cikarilamadi. Daha net, duz ve iyi isikli bir basili nota fotografi deneyin.")
    return mxl


def omr_to_notes(image_path, job_id, progress_cb=None):
    """Foto -> (notes, tempo, key_name, key_idx, key_is_major, cached).
    progress_cb(pct, msg) opsiyonel ilerleme bildirimi (arka plan job icin).
    read_midi_notes'u ANA venv'den lazy import eder (dairesel import'u onler)."""
    from music21 import converter, tempo as m21tempo
    from main import read_midi_notes, NOTE_NAMES  # lazy -> dairesel import yok
    import omr_cache

    def cb(p, m=None):
        if progress_cb:
            progress_cb(p, m)

    # 1) CACHE: ayni (SHA-256) veya benzer (pHash) gorsel daha once islendiyse oemer'i ATLA
    cb(10, "Onbellek kontrol ediliyor")
    cached = False
    mxl, matched_by, dist = omr_cache.lookup(image_path)
    if mxl:
        cached = True
        cb(85, "Onbellekten bulundu")
        print(f"OMR cache HIT ({matched_by}, hamming={dist})")
    else:
        # 2) On-isleme (varsayilan KAPALI) -> oemer -> MusicXML -> kalici cache'e yaz
        cb(15, "Nota taniniyor (birkac dakika surebilir)")
        proc = preprocess(image_path) if OMR_PREPROCESS else image_path
        out_dir = os.path.join(OUTPUT_DIR, "omr_" + job_id)
        raw_mxl = _run_oemer(proc, out_dir)
        mxl = omr_cache.store(image_path, raw_mxl)

    cb(90, "Nota kagidi hazirlaniyor")
    # 3) music21 parse
    try:
        score = converter.parse(mxl)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Nota dosyasi okunamadi: {str(e)[:120]}")

    # 4) tempo: metronom isareti, yoksa 120
    marks = list(score.recurse().getElementsByClass(m21tempo.MetronomeMark))
    bpm = 120
    for mk in marks:
        if mk.number:
            bpm = int(round(mk.number)); break
    # MIDI'nin saniye hesabi bu tempoya otursun diye basa metronom ekle
    if not marks:
        score.insert(0, m21tempo.MetronomeMark(number=bpm))

    # 5) key: analiz (backend detect_key ile ayni Krumhansl ailesi); yoksa Do major
    key_idx, key_is_major = 0, True
    try:
        k = score.analyze("key")
        key_idx = int(k.tonic.pitchClass)          # 0=Do/C .. 11=Si/B
        key_is_major = (k.mode == "major")
    except Exception:
        pass
    key_name = NOTE_NAMES[key_idx] + (" Major" if key_is_major else " Minor")

    # 6) MusicXML -> MIDI (outputs/{job}_full.mid) -> mevcut read_midi_notes
    midi_path = os.path.join(OUTPUT_DIR, f"{job_id}_full.mid")
    try:
        score.write("midi", fp=midi_path)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"MIDI'ye cevrilemedi: {str(e)[:120]}")

    notes = read_midi_notes(midi_path, monophonic=False, midi_range=None)
    if not notes:
        raise HTTPException(status_code=422, detail="Fotograftan gecerli nota cikmadi (bos sonuc). Daha net bir foto deneyin.")

    return notes, bpm, key_name, key_idx, key_is_major, cached
