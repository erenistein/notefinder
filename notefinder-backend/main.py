import os
import sys
import re
import json
import uuid
import subprocess
import shutil
import numpy as np
import librosa
from midiutil import MIDIFile
from fastapi import FastAPI, HTTPException, UploadFile, File, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from enum import Enum
import mido
from dotenv import load_dotenv
import jobs  # arka plan is mekanizmasi (registry + SQLite + ThreadPoolExecutor)

# .env'i yukle (LILYPOND_BIN vb. os.getenv ile okunabilsin)
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

# Arka plan job sure tahminleri (kaba ilerleme cubugu icin)
OMR_EST_SEC = 360        # oemer ~6 dk
TRANSCRIBE_EST_SEC = 180  # demucs+basic-pitch ~3 dk

app = FastAPI(title="NoteFindr API", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

UPLOAD_DIR = "uploads"
OUTPUT_DIR = "outputs"
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Backend acilista: onceki oturumdan yarim kalan (running/queued) isleri failed'a cevir
jobs.init_jobs()


@app.exception_handler(RuntimeError)
async def _runtime_error_handler(request: Request, exc: RuntimeError):
    """generate_pdf gibi RuntimeError firlatan yerler -> senkron istekte 500 + Turkce mesaj.
    (Async job'larda hata jobs.runner tarafindan yakalanir; bu handler yalniz istek dongusu icin.)"""
    return JSONResponse(status_code=500, content={"detail": str(exc)})

NOTE_NAMES = ["Do", "Do#", "Re", "Re#", "Mi", "Fa", "Fa#", "Sol", "Sol#", "La", "La#", "Si"]
LILY_NOTES = ["c", "cis", "d", "dis", "e", "f", "fis", "g", "gis", "a", "ais", "b"]
KEY_SIGNATURES = {
    0: ("c", "\\major"), 1: ("cis", "\\major"), 2: ("d", "\\major"), 3: ("ees", "\\major"),
    4: ("e", "\\major"), 5: ("f", "\\major"), 6: ("fis", "\\major"), 7: ("g", "\\major"),
    8: ("aes", "\\major"), 9: ("a", "\\major"), 10: ("bes", "\\major"), 11: ("b", "\\major"),
}
KEY_SIGNATURES_MINOR = {
    0: ("c", "\\minor"), 1: ("cis", "\\minor"), 2: ("d", "\\minor"), 3: ("ees", "\\minor"),
    4: ("e", "\\minor"), 5: ("f", "\\minor"), 6: ("fis", "\\minor"), 7: ("g", "\\minor"),
    8: ("gis", "\\minor"), 9: ("a", "\\minor"), 10: ("bes", "\\minor"), 11: ("b", "\\minor"),
}

# Krumhansl-Kessler ton profilleri (key tespiti). chroma-argmax minoru goremiyordu.
_KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
_KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

def detect_key(chroma_mean):
    """Krumhansl-Schmuckler ile key tespiti (major/minor ayrimi yapar).
    chroma_mean: 12'lik pitch-class enerji vektoru (index 0=Do/C).
    Donen: (key_idx, is_major, key_name)."""
    h = np.asarray(chroma_mean, dtype=float)
    if h.sum() <= 0:
        return 0, True, NOTE_NAMES[0] + " Major"
    h = h / h.sum()
    maj = np.array(_KS_MAJOR); maj = maj / maj.sum()
    minp = np.array(_KS_MINOR); minp = minp / minp.sum()
    best = None
    for shift in range(12):
        for prof, is_major in ((maj, True), (minp, False)):
            corr = np.corrcoef(h, np.roll(prof, shift))[0, 1]
            if best is None or corr > best[0]:
                best = (corr, shift, is_major)
    _, root, is_major = best
    return root, is_major, NOTE_NAMES[root] + (" Major" if is_major else " Minor")

def detect_tempo(y, sr):
    """Tempo tespiti — librosa varsayilani altbolunmus dokularda hizli oktava kayiyor
    (orn. Lento bir parcada gercek ~65 yerine ~108). Cozum: birden cok start_bpm
    tohumuyla beat_track calistir, kararli cekim noktalarini (cluster) bul; beraberlikte
    muzikal aralikta (55-100) DUSUK kumeyi tercih et — onset-darbe yanliligini dengeler.
    Net tek-baskin tempolar (pop vb.) aralik disindaysa oldugu gibi kalir."""
    try:
        oenv = librosa.onset.onset_strength(y=y, sr=sr)
        cands = []
        for sb in (50, 60, 70, 80, 90, 100, 120):
            t, _ = librosa.beat.beat_track(onset_envelope=oenv, sr=sr, start_bpm=sb)
            cands.append(float(np.atleast_1d(t)[0]))
        cands.sort()
        clusters = []
        for c in cands:
            for cl in clusters:
                if abs(c - np.median(cl)) / np.median(cl) < 0.06:
                    cl.append(c)
                    break
            else:
                clusters.append([c])
        maxlen = max(len(cl) for cl in clusters)
        competitive = [cl for cl in clusters if len(cl) >= maxlen - 1 and len(cl) >= 2]
        in_range = [cl for cl in competitive if 55 <= np.median(cl) <= 100]
        chosen = min(in_range, key=lambda cl: np.median(cl)) if in_range else max(clusters, key=len)
        return max(40, min(int(round(np.median(chosen))), 180))
    except Exception as e:
        print(f"Tempo tespiti hatasi: {e}")
        t, _ = librosa.beat.beat_track(y=y, sr=sr)
        return max(40, min(int(float(np.atleast_1d(t)[0])), 180))

class InstrumentType(str, Enum):
    PIANO = "piano"
    GUITAR = "guitar"
    SAZ = "saz"
    VIOLIN = "violin"
    UD = "ud"

class LinkRequest(BaseModel):
    url: str
    instrument: InstrumentType = InstrumentType.PIANO

class LinkResponse(BaseModel):
    job_id: str
    status: str
    message: str
    filename: str = ""
    title: str = ""

class TranscribeRequest(BaseModel):
    job_id: str
    instrument: InstrumentType = InstrumentType.PIANO
    use_demucs: bool = True

class TranscribeResponse(BaseModel):
    job_id: str
    status: str
    tempo: int = 0
    key: str = ""
    total_notes: int = 0
    duration_seconds: float = 0
    notes: list = []
    midi_file: str = ""
    pdf_file: str = ""
    cached: bool = False  # OMR: sonuc cache'ten mi geldi (ayni/benzer foto daha once islendi)

class ConvertRequest(BaseModel):
    job_id: str
    target_instrument: InstrumentType = InstrumentType.PIANO

class ConvertResponse(BaseModel):
    source_job_id: str
    target_instrument: str
    out_job_id: str
    pdf_file: str = ""
    midi_file: str = ""
    total_notes: int = 0
    notes: list = []

class OmrRequest(BaseModel):
    job_id: str
    instrument: InstrumentType = InstrumentType.PIANO

# ─── Yardimci Fonksiyonlar ───

def hz_to_note_name(freq):
    if freq <= 0:
        return "?"
    midi_num = int(round(12 * np.log2(freq / 440.0) + 69))
    octave = (midi_num // 12) - 1
    note_idx = midi_num % 12
    return f"{NOTE_NAMES[note_idx]}{octave}"

def hz_to_midi(freq):
    if freq <= 0:
        return 0
    return int(round(12 * np.log2(freq / 440.0) + 69))

def midi_to_lily_pitch(midi_num):
    """Sadece nota adi (sure yok). Akor render'i icin gerekli."""
    note_idx = midi_num % 12
    octave = (midi_num // 12) - 1
    lily_note = LILY_NOTES[note_idx]
    if octave >= 4:
        lily_note += "'" * (octave - 3)
    elif octave < 3:
        lily_note += "," * (3 - octave)
    return lily_note

def beats_to_lily_dur(beats):
    """Vurus suresini en yakin standart LilyPond sure token'ina cevirir.
    Esikler orta-nokta: 1 vurus -> '4' (ceyrek), 1.5 -> '4.', 2 -> '2' ...
    (Eski surum esikleri kaymisti: 1 vurusu '4.' yapip sureleri sisiriyordu.)"""
    if beats >= 3.5:        # tam nota (4)
        return "1"
    elif beats >= 2.5:      # noktali yarim (3)
        return "2."
    elif beats >= 1.75:     # yarim (2)
        return "2"
    elif beats >= 1.25:     # noktali ceyrek (1.5)
        return "4."
    elif beats >= 0.875:    # ceyrek (1)
        return "4"
    elif beats >= 0.625:    # noktali sekizlik (0.75)
        return "8."
    elif beats >= 0.4375:   # sekizlik (0.5)
        return "8"
    elif beats >= 0.3125:   # noktali onaltilik (0.375)
        return "16."
    elif beats >= 0.1875:   # onaltilik (0.25)
        return "16"
    else:                   # otuzikilik (0.125)
        return "32"

def dur_to_lily_token(duration_sec, tempo):
    return beats_to_lily_dur(duration_sec * (tempo / 60.0))

def split_beats_to_durs(beats):
    """Bir sureyi (vurus cinsinden) standart sure token'larina boler.
    Sus (rest) bolmek icin kullanilir: 2.5 vurus -> ['2', '8'] gibi. 16'lik cozunurluk."""
    units = int(round(beats * 4))  # 16'lik birim sayisi
    table = [(16, "1"), (12, "2."), (8, "2"), (6, "4."), (4, "4"), (3, "8."), (2, "8"), (1, "16")]
    tokens = []
    while units > 0:
        for u, tok in table:
            if u <= units:
                tokens.append(tok)
                units -= u
                break
        else:
            break
    return tokens

def midi_to_lily(midi_num, duration_sec, tempo):
    return midi_to_lily_pitch(midi_num) + dur_to_lily_token(duration_sec, tempo)

def quantize_notes(notes, tempo):
    """Onset-temelli + polifonik quantize.

    Eski surum notalari kumulatif sure toplamiyla dizip gercek zamani yok ediyordu;
    bu da akorlari (ayni anda calan notalar) sisirip iki portenin senkronunu bozuyordu.
    Yeni surum:
      1) Her notanin GERCEK baslangic zamanini 16'lik grid'e snap'ler (kumulatif degil).
      2) Ayni grid kutusuna dusen notalari AKOR olarak gruplar -> 'midis' listesi.
      3) Notalar arasi bosluklara SUS (rest) olayi ekler -> is_rest=True.
      4) Nota suresini bir sonraki onset'e kadar kirpar (ust uste binmeyi onler).

    Cikti: olay (event) listesi. Her olay sozlugu: start/end/duration (saniye),
    midi (tek/temsil nota), midis (akor notalari), is_rest (bool).
    Hem piyano (her el ayri) hem tek-porte yollari ayni mutlak grid'i kullandigi
    icin notalar dogru hizalanir. notes_to_lily_string bu olaylari render eder.
    """
    if not notes:
        return []
    beat_dur = 60.0 / tempo
    grid = beat_dur / 4.0  # 16'lik nota grid'i
    dur_grid_beats = [4.0, 3.0, 2.0, 1.5, 1.0, 0.75, 0.5, 0.375, 0.25, 0.125]

    # 1) Baslangic ve sureyi grid'e snap'le (gercek onset korunur)
    snapped = []
    for n in notes:
        start = round(n["start"] / grid) * grid
        raw_dur = max(n.get("duration", grid), grid)
        best = min(dur_grid_beats, key=lambda g: abs(raw_dur - g * beat_dur))
        dur = best * beat_dur
        m = dict(n)
        m["start"] = start
        m["duration"] = dur
        m["end"] = start + dur
        snapped.append(m)
    snapped.sort(key=lambda x: (x["start"], x["midi"]))

    # 2) Ayni anda baslayan notalari akor olarak grupla
    eps = grid * 0.5
    events = []
    i = 0
    while i < len(snapped):
        j = i + 1
        group = [snapped[i]]
        while j < len(snapped) and abs(snapped[j]["start"] - snapped[i]["start"]) < eps:
            group.append(snapped[j])
            j += 1
        # Ayni perde tekrarinda en yuksek velocity'li ornegi tut
        uniq = {}
        for g in group:
            if g["midi"] not in uniq or g.get("velocity", 0) > uniq[g["midi"]].get("velocity", 0):
                uniq[g["midi"]] = g
        members = sorted(uniq.values(), key=lambda x: x["midi"])
        # Akor yogunluk siniri: el basina en fazla 3 ses (bas + en guclu orta + tepe)
        # -> okunaklilik korunur, dikey kalabalik olmaz.
        if len(members) > 3:
            low, high = members[0], members[-1]
            mid = max(members[1:-1], key=lambda x: x.get("velocity", 0))
            members = sorted([low, mid, high], key=lambda x: x["midi"])
        midis = [g["midi"] for g in members]
        ev = dict(group[0])
        ev["start"] = group[0]["start"]
        ev["midis"] = midis
        ev["midi"] = midis[-1]  # temsil: en tiz nota (melodi)
        ev["duration"] = max(g["duration"] for g in group)
        ev["end"] = ev["start"] + ev["duration"]
        ev["is_rest"] = False
        events.append(ev)
        i = j

    # 3) Sureyi sonraki onset'e kadar kirp + bosluklara sus ekle
    result = []
    cursor = 0.0
    for k, ev in enumerate(events):
        gap = ev["start"] - cursor
        if gap >= grid * 0.9:
            rest_units = max(1, int(round(gap / grid)))
            rest_dur = rest_units * grid
            result.append({
                "midi": 0, "midis": [], "is_rest": True,
                "note": "rest", "velocity": 0,
                "start": round(cursor, 4),
                "duration": round(rest_dur, 4),
                "end": round(cursor + rest_dur, 4),
            })
            cursor += rest_dur
        next_start = events[k + 1]["start"] if k + 1 < len(events) else ev["end"]
        max_dur = next_start - ev["start"]
        dur = ev["duration"]
        if max_dur >= grid * 0.9 and dur > max_dur:
            best = min(dur_grid_beats, key=lambda g: abs(max_dur - g * beat_dur))
            dur = best * beat_dur
            if dur > max_dur:
                dur = max(grid, round(max_dur / grid) * grid)
        dur = max(dur, grid)
        ev["start"] = round(ev["start"], 4)
        ev["duration"] = round(dur, 4)
        ev["end"] = round(ev["start"] + dur, 4)
        result.append(ev)
        cursor = ev["end"]
    return result

def detect_triplets(notes, tempo):
    triplet_groups = []
    beat_dur = 60.0 / tempo
    for i in range(len(notes) - 2):
        d1 = notes[i]["duration"]
        d2 = notes[i + 1]["duration"]
        d3 = notes[i + 2]["duration"]
        total = d1 + d2 + d3
        if abs(total - beat_dur) < beat_dur * 0.3:
            if abs(d1 - d2) < d1 * 0.4 and abs(d2 - d3) < d2 * 0.4:
                triplet_groups.append(i)
    return triplet_groups
def run_piano_transcription(wav_path, job_id):
    """Piyano icin ozel ML modeli (piano_transcription_inference)"""
    try:
        venv310_python = os.path.join(os.path.dirname(os.path.abspath(__file__)), "venv310", "Scripts", "python.exe")
        midi_out = os.path.join(OUTPUT_DIR, f"{job_id}_piano_ml.mid")
        
        # Ayri script ile calistir
        script = f'''
import librosa
import torch
from piano_transcription_inference import PianoTranscription, sample_rate
device = "cuda" if torch.cuda.is_available() else "cpu"
print(f"Cihaz: {{device}}")
audio, _ = librosa.load(r"{wav_path}", sr=sample_rate, mono=True)
transcriptor = PianoTranscription(device=device, checkpoint_path=None)
transcriptor.transcribe(audio, r"{midi_out}")
print("PIANO_ML_DONE")
'''
        script_path = os.path.join(OUTPUT_DIR, f"piano_script_{job_id}.py")
        with open(script_path, "w", encoding="utf-8") as f:
            f.write(script)
        
        print(f"Piyano ML modeli baslatiliyor: {wav_path}")
        result = subprocess.run(
            [venv310_python, script_path],
            capture_output=True, text=True, timeout=600,
        )
        print(f"Piyano ML bitti. Return code: {result.returncode}")
        
        if os.path.exists(midi_out):
            print(f"Piyano ML MIDI bulundu: {midi_out}")
            return midi_out
        print(f"Piyano ML MIDI bulunamadi. stderr: {result.stderr[:300]}")
        return None
    except Exception as e:
        print(f"Piyano ML hatasi: {e}")
        return None
# ─── Basic Pitch ───

# basic-pitch icin enstruman-ozel frekans araligi (Hz). Aralik-disi hayalet notalari /
# yan harmonikleri / bas-drone'u keser. Alt sinir gercek en pes notanin biraz altinda,
# ust sinir gercek en tiz notanin biraz ustunde ama harmonikleri disarida birakacak kadar dar.
# Piyano burada YOK: piyano basic-pitch kullanmaz (ozel ML), sinir uygulanmaz -> varsayilan kalir.
BASIC_PITCH_FREQ_RANGE = {
    "guitar": (75, 1400),    # E2≈82 – E6≈1318
    "saz": (135, 1250),      # D3≈146 – D6≈1174
    "violin": (185, 2800),   # G3≈196 – E7≈2637
    "ud": (100, 1100),       # ud saz'dan biraz daha pes; alt sinir drone'u keser
}

# Enstruman FIZIKSEL perde araligi (MIDI). basic-pitch/librosa CIKTISINA sert filtre.
# BASIC_PITCH_FREQ_RANGE yumusak ipucu (basic-pitch sinirin altinda nota verebiliyor);
# bu ise cikan notalari kesin sinirin disindaysa atar (orn. gitarda bas/davul sizintisi).
INSTRUMENT_MIDI_RANGE = {
    "guitar": (40, 88),    # E2 (en pes tel) - E6
    "saz": (48, 87),       # ~135-1250 Hz karsiligi
    "ud": (43, 85),        # ~100-1100 Hz karsiligi
    "violin": (55, 100),   # ~185-2800 Hz karsiligi
    # piano: filtre YOK (ML temiz, genis aralik gerekli)
}

# Nota sayisi backstop'u: SADECE patolojik girdiye karsi son care (orn. basic-pitch
# gurultude on binlerce hayalet nota uretirse). Gercek muzik buraya ASLA dokunmaz:
# yogun/polifonik/demucs'lu bir mix bile ~580 nota/dk uretir, 10 dk'lik parca ~6000 =>
# 20000'de 3 kat pay var. Asil patolojik-girdi korumasi LilyPond'un 240 sn timeout'u
# ve link SURE kapisidir; bu sadece son savunma hatti. Buraya carpmak = ariza durumu.
MAX_NOTES = 20000

def run_basic_pitch(wav_path, job_id, instrument="guitar"):
    try:
        bp_output_dir = os.path.join(OUTPUT_DIR, "bp_" + job_id)
        os.makedirs(bp_output_dir, exist_ok=True)
        venv310_python = os.path.join(os.path.dirname(os.path.abspath(__file__)), "venv310", "Scripts", "python.exe")
        inst = instrument.value if hasattr(instrument, "value") else str(instrument)
        print(f"Basic-pitch baslatiliyor: {wav_path} (enstruman: {inst})")
        # NOT: 'basic_pitch' paketinde __main__ yok; dogru cagri 'basic_pitch.predict'.
        # --save-midi olmadan MIDI dosyasi yazilmaz, bu yuzden bayrak sart.
        # basic_pitch CLI'si banner'da emoji (U+2728) yazdiriyor; Turkce Windows (cp1254)
        # bunu kodlayamayip cokuyor. UTF-8 zorlayarak bunu onluyoruz.
        bp_env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
        cmd = [venv310_python, "-m", "basic_pitch.predict", "--save-midi"]
        # Enstrumana ozel frekans sinirini ekle (sadece guitar/saz/violin; piyano varsayilan).
        freq = BASIC_PITCH_FREQ_RANGE.get(inst)
        if freq:
            cmd += ["--minimum-frequency", str(freq[0]), "--maximum-frequency", str(freq[1])]
            print(f"Frekans araligi: {freq[0]}-{freq[1]} Hz")
        cmd += [bp_output_dir, wav_path]
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=300, env=bp_env,
        )
        print(f"Basic-pitch bitti. Return code: {result.returncode}")
        for f in os.listdir(bp_output_dir):
            if f.endswith(".mid"):
                midi_path = os.path.join(bp_output_dir, f)
                print(f"Basic-pitch MIDI bulundu: {midi_path}")
                return midi_path
        print(f"Basic-pitch MIDI bulunamadi. stderr: {result.stderr[:300]}")
        return None
    except Exception as e:
        print(f"Basic-pitch hatasi: {e}")
        return None

def _enforce_monophonic(notes, eps=0.02, min_dur=0.06):
    """SUSTAIN boyunca monofonik (skyline): monofonik enstrumanda ayni anda TEK nota calar.
    Iki nota zaman-ortusuyorsa GUCLU olani (velocity) tutulur; melodi silinmez, azaltilir.
    - Ortusme yoksa (yeni.start >= onceki.end - eps): iki nota da kalir.
    - Ortusme + yeni daha guclu: onceki, yeni.start'a kadar KISALTILIR (onset korunur);
      kisalinca cok kisa (<min_dur) kalirsa onceki atilir. Yeni eklenir.
    - Ortusme + onceki >= yeni: yeni'nin ortusen kismi atilir; ama yeni onceki'nin bitisinden
      belirgin (>min_dur) SONRA da uzuyorsa, o KUYRUK melodik nota olabilir -> baslangici
      onceki.end'e kaydirilip tutulur (aksi halde tamamen atilir).
    Notlar start'a gore sirali gelmeli. Sadece monofonik enstrumanlarda cagrilir (saz/ud/violin).
    """
    if len(notes) < 2:
        return notes
    out = [notes[0]]
    for n in notes[1:]:
        prev = out[-1]
        prev_end = prev["start"] + prev["duration"]
        if n["start"] >= prev_end - eps:
            out.append(n)                      # ortusme yok -> ikisi de kalir
        elif n["velocity"] > prev["velocity"]:
            # yeni guclu: onceki'yi kisalt (onset koru), cok kisa kalirsa at
            new_prev_dur = n["start"] - prev["start"]
            if new_prev_dur >= min_dur:
                prev["duration"] = round(new_prev_dur, 3)
                prev["end"] = round(prev["start"] + prev["duration"], 3)
            else:
                out.pop()
            out.append(n)
        else:
            # onceki guclu (>=): yeni'nin ortusen kismi gider; belirgin kuyrugu varsa koru
            n_end = n["start"] + n["duration"]
            if n_end > prev_end + min_dur:
                n["start"] = round(prev_end, 3)
                n["duration"] = round(n_end - prev_end, 3)
                n["end"] = round(n_end, 3)
                out.append(n)
            # aksi halde yeni tamamen atilir
    return out

def read_midi_notes(midi_path, monophonic=False, midi_range=None):
    try:
        mid = mido.MidiFile(midi_path)
        # Tick'i saniyeye cevirmek icin tempo ve ticks_per_beat lazim
        ticks_per_beat = mid.ticks_per_beat
        tempo_us = 500000  # varsayilan 120 BPM (mikrosaniye/beat)
        
        # Once tempo mesajini bul
        for track in mid.tracks:
            for msg in track:
                if msg.type == 'set_tempo':
                    tempo_us = msg.tempo
                    break
        
        seconds_per_tick = (tempo_us / 1000000.0) / ticks_per_beat
        
        notes = []
        for track in mid.tracks:
            current_tick = 0
            active_notes = {}
            for msg in track:
                current_tick += msg.time
                if msg.type == 'note_on' and msg.velocity > 0:
                    active_notes[msg.note] = {"tick": current_tick, "velocity": msg.velocity}
                elif msg.type == 'note_off' or (msg.type == 'note_on' and msg.velocity == 0):
                    if msg.note in active_notes:
                        start_tick = active_notes[msg.note]["tick"]
                        velocity = active_notes[msg.note]["velocity"]
                        start_sec = start_tick * seconds_per_tick
                        end_sec = current_tick * seconds_per_tick
                        duration = end_sec - start_sec
                        midi_num = msg.note
                        # midi_range verildiyse enstruman araligi disindaki notayi ATLA (sert filtre)
                        in_range = (midi_range is None) or (midi_range[0] <= midi_num <= midi_range[1])
                        if duration > 0.05 and velocity > 30 and in_range:
                            notes.append({
                                "note": hz_to_note_name(440.0 * (2.0 ** ((midi_num - 69) / 12.0))),
                                "midi": midi_num,
                                "start": round(start_sec, 3),
                                "end": round(end_sec, 3),
                                "duration": round(duration, 3),
                                "velocity": velocity,
                            })
                        del active_notes[msg.note]
        notes.sort(key=lambda x: x["start"])
        
        # Cok yakin zamanda baslayan notalari grupla.
        # monophonic=False (gitar/piyano): en guclu 3 notayi tut (akor).
        # monophonic=True (saz/keman): SADECE en guclu tek notayi tut -> basic-pitch'in
        #   sactigi yan harmonik/oktav artiklari elenir (monofonik enstrumanda tek nota calar).
        keep = 1 if monophonic else 3
        filtered = []
        i = 0
        while i < len(notes):
            group = [notes[i]]
            j = i + 1
            while j < len(notes) and notes[j]["start"] - notes[i]["start"] < 0.05:
                group.append(notes[j])
                j += 1
            group.sort(key=lambda x: x["velocity"], reverse=True)  # en guclu (velocity) once
            for n in group[:keep]:
                filtered.append(n)
            i = j

        filtered.sort(key=lambda x: x["start"])
        # SUSTAIN monofonik: 50ms baslangic penceresi, bir nota SURERKEN ~100ms sonra
        # baslayan ortusen notayi kaciriyordu. Monofonik enstrumanlarda (saz/ud/violin)
        # tum sure boyunca tek-ses zorla -> harmonik/rezonans/sizinti ortusmeleri elenir.
        if monophonic:
            filtered = _enforce_monophonic(filtered)
        return filtered
    except Exception as e:
        print(f"MIDI okuma hatasi: {e}")
        return []

# ─── Demucs ───

def has_vocals(wav_path):
    try:
        y, sr = librosa.load(wav_path, sr=22050, mono=True, duration=30)
        S = np.abs(librosa.stft(y))
        freqs = librosa.fft_frequencies(sr=sr)
        vocal_range = (freqs >= 300) & (freqs <= 3400)
        full_range = (freqs >= 20) & (freqs <= 8000)
        vocal_energy = np.mean(S[vocal_range, :])
        total_energy = np.mean(S[full_range, :])
        if total_energy == 0:
            return False
        vocal_ratio = vocal_energy / total_energy
        print(f"Vokal orani: {vocal_ratio:.3f}")
        return vocal_ratio > 0.6
    except Exception:
        return True

def separate_audio(wav_path, instrument="piano"):
    try:
        if not has_vocals(wav_path):
            print("Vokal tespit edilmedi, demucs atlaniyor")
            return wav_path
        output_dir = os.path.join(OUTPUT_DIR, "separated")
        os.makedirs(output_dir, exist_ok=True)
        print(f"Demucs baslatiliyor (4 stem): {wav_path}")
        # sys.executable = backend'i calistiran ANA venv python'u (demucs orada kurulu).
        # Bare "python" Windows Store stub'ina dusup "No module named demucs" veriyordu.
        result = subprocess.run(
            [sys.executable, "-m", "demucs",
             "-o", output_dir,
             "--filename", "{track}/{stem}.{ext}",
             wav_path],
            capture_output=True, text=True, timeout=600,
        )
        print(f"Demucs bitti. Return code: {result.returncode}")
        track_name = os.path.splitext(os.path.basename(wav_path))[0]
        base_dir = os.path.join(output_dir, "htdemucs", track_name)
        
        # Enstrumana gore dogru stem sec
        if instrument in ["guitar", "saz", "violin", "ud"]:
            # "other" = melodic instruments (gitar, saz, keman vs)
            target = os.path.join(base_dir, "other.wav")
        elif instrument == "piano":
            # Piyano icin no_vocals (bas + other birlikte)
            target = os.path.join(base_dir, "other.wav")
        else:
            target = os.path.join(base_dir, "other.wav")
        
        if os.path.exists(target):
            print(f"Ayrilmis dosya bulundu: {target}")
            return target
        
        # 4 stem bulunamazsa 2 stem dene
        no_vocals = os.path.join(base_dir, "no_vocals.wav")
        if os.path.exists(no_vocals):
            print(f"no_vocals bulundu: {no_vocals}")
            return no_vocals
        
        # Hicbiri yoksa orijinal
        for root, dirs, files in os.walk(output_dir):
            for f in files:
                if "other" in f and f.endswith(".wav"):
                    return os.path.join(root, f)
        
        print("Ayrilmis dosya bulunamadi, orijinal kullaniliyor")
        return wav_path
    except Exception as e:
        print(f"Demucs hatasi: {e}")
        return wav_path

# ─── LilyPond PDF ───

def _hand_split_point(pitches):
    """Sag/sol el ayrim perdesi: 1B Otsu ile bas/tiz kumelerini ayiran esigi bul,
    [54,64] (Fa#3-Mi4) araligina sikistir, varsayilan 60 (Do4). Parcaya uyarlanir
    ama hicbir zaman saglam araligin disina cikmaz."""
    ps = [p for p in pitches if p and p > 0]
    if not ps:
        return 60
    hist = np.zeros(128)
    for p in ps:
        hist[int(p)] += 1
    best_t, best_var = 60, -1.0
    idx = np.arange(128)
    for t in range(54, 65):
        w0, w1 = hist[:t].sum(), hist[t:].sum()
        if w0 == 0 or w1 == 0:
            continue
        m0 = (hist[:t] * idx[:t]).sum() / w0
        m1 = (hist[t:] * idx[t:]).sum() / w1
        var = w0 * w1 * (m0 - m1) ** 2  # siniflar-arasi varyans (Otsu)
        if var > best_var:
            best_var, best_t = var, t
    return best_t

def improve_hand_separation(notes, tempo):
    """Sag/sol el ayrimi - REGISTER (perde) temelli.
    Eski surum 'zaman-kumesinin en tiz notasi -> sag, gerisi -> sol' yapiyordu;
    bu da arpejleri (ardisik kirik akor) blok-oktava cevirip dokuyu fakirlestiriyordu.
    Yeni surum: perde ayrim noktasinin ustu -> sag el, alti -> sol el. Boylece
    arpej notalari sol elde akici bir CIZGI olarak kalir (akor gruplama/sus/olcu
    islemini sonra quantize_notes yapar; akorlar el basina 3 sesle sinirli)."""
    if not notes:
        return [], []
    beat_dur = 60.0 / tempo
    grid = beat_dur / 4.0
    split = _hand_split_point([n["midi"] for n in notes])
    right_hand = [n for n in notes if n["midi"] >= split]
    left_hand = [n for n in notes if n["midi"] < split]

    def dedupe(hand):
        # Yalnizca ayni perdenin bitisik tekrarini birlestir (sustain artefakti);
        # farkli perdeler (arpej) dokunulmaz.
        out = []
        for n in sorted(hand, key=lambda x: x["start"]):
            if out and out[-1]["midi"] == n["midi"] and (n["start"] - out[-1]["end"]) < grid:
                out[-1]["end"] = n["end"]
                out[-1]["duration"] = out[-1]["end"] - out[-1]["start"]
            else:
                out.append(dict(n))
        return out

    return dedupe(right_hand), dedupe(left_hand)

def _pitch_token(midis, is_rest):
    """Sure olmadan nota/akor/sus basligini uretir: 'r', 'cis', '<c e g>'."""
    if is_rest or not midis:
        return "r"
    if len(midis) == 1:
        return midi_to_lily_pitch(midis[0])
    return "<" + " ".join(midi_to_lily_pitch(m) for m in midis) + ">"

def _note_label(midis):
    """Notanin/akorun altina basilacak Do-Re-Mi etiketi: _"Do" gibi (LilyPond TextScript).
    Akorda tek isim = KOK (en pes) nota. Sabit Do (fixed-Do): NOTE_NAMES[midi%12], tondan
    bagimsiz, hep diyez. Adim 1 sabit Turkce; dil secimi/toggle sonraki adimlarda.
    Yalniz nota-basi token'a eklenir (sus/tie-devami cagirmaz)."""
    if not midis:
        return ""
    return '_"' + NOTE_NAMES[min(midis) % 12] + '"'

def split_units_to_durs(units):
    """16'lik birim sayisini standart LilyPond sure token'larina boler (5 -> ['4','16'])."""
    table = [(16, "1"), (12, "2."), (8, "2"), (6, "4."), (4, "4"), (3, "8."), (2, "8"), (1, "16")]
    toks = []
    while units > 0:
        for u, t in table:
            if u <= units:
                toks.append(t)
                units -= u
                break
        else:
            break
    return toks

def _is_triplet_group(events, i, tempo):
    """events[i:i+3] bir ucleme (triole) mi? Uc non-rest nota, birbirine yakin sureli,
    toplami ~1 vurus. Grid'e snap'lenmis ucleme sekizlikleri bu desene uyar."""
    if i + 2 >= len(events):
        return False
    grp = events[i:i + 3]
    if any(e.get("is_rest") for e in grp):
        return False
    beat = 60.0 / tempo
    durs = [e["duration"] for e in grp]
    total = sum(durs)
    if abs(total - beat) > beat * 0.35:
        return False
    avg = total / 3.0
    if avg <= 0 or any(abs(d - avg) > avg * 0.5 for d in durs):
        return False
    return True

def _apply_slurs(tokens):
    """Bir olcu icindeki ardisik nota gruplarina bag (slur) ekler: ( ... ).
    Sus ('r') ve tuplet ('\\') gruplari bagi keser. En az 2 nota gerekir."""
    def is_note(t):
        return not t.startswith("r") and not t.startswith("\\")
    runs = []
    start = None
    for idx, t in enumerate(tokens):
        if is_note(t):
            if start is None:
                start = idx
        else:
            if start is not None and idx - start >= 2:
                runs.append((start, idx - 1))
            start = None
    if start is not None and len(tokens) - start >= 2:
        runs.append((start, len(tokens) - 1))
    for a, b in runs:
        tokens[a] = tokens[a] + "("
        tokens[b] = tokens[b] + ")"

def render_voice_measures(events, tempo, with_slurs=True):
    """Olay listesini 4/4 olculere boler. Donen: olcu listesi (her olcu = token listesi).
    - Olcu sinirini gecen nota tie (~) ile bir sonraki olcuye baglanir.
    - Son (eksik) olcu sus ile doldurulur -> her olcu tam 4 vurus.
    - Uclemeler \\tuplet 3/2 { ... } olarak render edilir (olcude 1 vurus = 4 birim).
    - with_slurs: ayni olcudeki ardisik nota gruplarina bag ekler.
    Tum olculer tam 4 vurus oldugu icin piyanoda iki porte birebir hizalanir.
    """
    grid = (60.0 / tempo) / 4.0
    UPM = 16  # olcu basina 16'lik birim (4/4)
    measures = []
    current = []
    pos = 0

    def close_measure():
        nonlocal current, pos
        if with_slurs:
            _apply_slurs(current)
        measures.append(current)
        current = []
        pos = 0

    i = 0
    n = len(events)
    while i < n:
        # Ucleme: mevcut olcuye 1 tam vurus (4 birim) sigiyorsa tek blok olarak yerlestir
        if _is_triplet_group(events, i, tempo) and (UPM - pos) >= 4:
            # Ucleme: her nota gercek nota-basi -> her birine isim (tie/sus yok iceride)
            inner = []
            for e in events[i:i + 3]:
                ms = e.get("midis") or [e["midi"]]
                inner.append(_pitch_token(ms, False) + "8" + _note_label(ms))
            current.append("\\tuplet 3/2 { " + " ".join(inner) + " }")
            pos += 4
            i += 3
            if pos >= UPM:
                close_measure()
            continue

        ev = events[i]
        is_rest = ev.get("is_rest", False)
        midis = [] if is_rest else (ev.get("midis") or [ev["midi"]])
        pitch = _pitch_token(midis, is_rest)
        # Isim SADECE notanin ilk (nota-basi) token'ina; tie ile bolunen devam
        # parcalarina ve suslere yazilmaz (yoksa ayni nota iki kez isimlenir).
        label = "" if is_rest else _note_label(midis)
        named = False
        units = max(1, int(round(ev["duration"] / grid)))
        while units > 0:
            take = min(UPM - pos, units)
            durs = split_units_to_durs(take)
            will_continue = (units - take) > 0
            for di, d in enumerate(durs):
                last_of_take = (di == len(durs) - 1)
                tie = "~" if (not is_rest and ((not last_of_take) or will_continue)) else ""
                lbl = label if (label and not named) else ""
                if lbl:
                    named = True
                # sira: perde + sure + isim(_"Do") + tie(~); slur '(' sonradan eklenir
                current.append(pitch + d + lbl + tie)
            pos += take
            units -= take
            if pos >= UPM:
                close_measure()
        i += 1

    # Son eksik olcuyu sus ile doldur
    if pos > 0:
        for d in split_units_to_durs(UPM - pos):
            current.append("r" + d)
        close_measure()
    return measures

def measures_to_lily(measures):
    """Olcu listesini barline'li ('|') LilyPond dizisine cevirir (satir kaydirmali)."""
    if not measures:
        return ""
    parts = [" ".join(m) for m in measures]
    lines = []
    for j in range(0, len(parts), 4):
        lines.append(" | ".join(parts[j:j + 4]))
    return " |\n      ".join(lines) + " |"

# ─── Ardisik tekrar tespiti (tek-porte: \repeat volta) ───
REPEAT_SIMILARITY = 0.90  # iki blok "ayni tekrar" sayilmak icin normalize olculerin min eslesme orani

def normalize_measure(tokens):
    """Bir olcunun token'larindan KARSILASTIRMA icin kozmetik isaretleri soyar:
    slur ( ), tie ~, dinamik/komut (\\p, \\sustainOn ...). Sadece perde+sure kalir.
    NOT: yalnizca tekrar karsilastirmasi icindir; render edilen ASIL olculer DEGISMEZ."""
    norm = []
    for t in tokens:
        s = t.replace("~", "").replace("(", "").replace(")", "")
        s = re.sub(r'_"[^"]*"', "", s)     # nota-alti isim _"Do" -> tekrar karsilastirmasi isim-kor olsun
        s = re.sub(r"\\[a-zA-Z]+", "", s)  # \p \mf \sustainOn vb. dinamik/komutlar
        norm.append(s.strip())
    return tuple(norm)

def _blocks_equal(measures, a, b, n):
    """measures[a:a+n] ile measures[b:b+n] bloklari yeterince benzer mi (olcu-olcu, normalize)."""
    match = sum(1 for k in range(n)
                if normalize_measure(measures[a + k]) == normalize_measure(measures[b + k]))
    return (match / n) >= REPEAT_SIMILARITY

def detect_repeats(measures):
    """Ardisik tekrar eden bloklari bulur. Donen segment listesi:
      ("plain",  [olcu, ...])      -> tekrar yok, duz
      ("repeat", N, [olcu, ...])   -> blok N kez ardisik tekrarliyor (ilk kopya tutulur)
    Guvenlik: yalniz gercekten ardisik + esik ustu tekrar varsa sarilir; aksi halde duz.
    Hic tekrar yoksa tek bir ("plain", tum-olculer) doner -> cikti AYNEN eskisi gibi."""
    segments = []
    plain = []
    M = len(measures)
    i = 0

    def flush():
        if plain:
            segments.append(("plain", plain[:]))
            plain.clear()

    while i < M:
        found = False
        for n in (4, 8):  # once daha siki (4) blok; tutmazsa 8
            if i + 2 * n > M:
                continue
            reps = 1
            while i + (reps + 1) * n <= M and _blocks_equal(measures, i, i + reps * n, n):
                reps += 1
            if reps >= 2:
                flush()
                block = [list(m) for m in measures[i:i + n]]  # kopya; asil olculer degismez
                # Blok sonunda sarkan tie'yi (~) temizle -> :| sinirinda dangling tie/uyari olmasin
                if block and block[-1] and block[-1][-1].endswith("~"):
                    block[-1][-1] = block[-1][-1][:-1]
                segments.append(("repeat", reps, block))
                i += reps * n
                found = True
                break
        if not found:
            plain.append(measures[i])
            i += 1
    flush()
    return segments

def segments_to_lily(segments):
    """Segment listesini LilyPond dizisine cevirir.
    Duz segmentler mevcut measures_to_lily ile (onceki davranisla BIREBIR);
    tekrar segmentleri \\repeat volta N { ... } ile sarilir."""
    parts = []
    for seg in segments:
        if seg[0] == "plain":
            parts.append(measures_to_lily(seg[1]))
        else:
            _, n, ms = seg
            body = " | ".join(" ".join(m) for m in ms)
            parts.append("\\repeat volta " + str(n) + " { " + body + " }")
    return "\n      ".join(parts)

def notes_to_lily_string(notes, tempo, triplet_indices=None):
    """quantize_notes ciktisini olcu-yapili LilyPond dizisine cevirir (tek-porte yollari icin).
    Ardisik tekrar eden bloklar \\repeat volta ile sikistirilir (tekrar yoksa cikti aynen kalir).
    triplet_indices artik kullanilmiyor; imza uyumlulugu icin tutuluyor."""
    if not notes:
        return ""
    measures = render_voice_measures(notes, tempo, with_slurs=True)
    segments = detect_repeats(measures)
    return segments_to_lily(segments)

def build_single_staff_ly(song_title, inst_display, inst_short, clef, key_note, key_mode, tempo, melody_notes, inst_type=None):
    ly = '\\version "2.26.0"\n'
    ly += '\\header {\n'
    ly += '  title = "' + song_title + '"\n'
    ly += '  subtitle = "' + inst_display + ' - Tempo: ' + str(tempo) + ' BPM"\n'
    ly += '  composer = "NoteFindr ile olusturuldu"\n'
    ly += '  tagline = ##f\n'
    ly += '}\n\n'
    ly += '\\score {\n'
    ly += '  \\new Staff \\with { instrumentName = "' + inst_short + '" } {\n'
    ly += '    \\clef ' + clef + '\n'
    ly += '    \\key ' + key_note + ' ' + key_mode + '\n'
    ly += '    \\tempo 4 = ' + str(tempo) + '\n'
    ly += '    \\time 4/4\n'
    ly += '    ' + melody_notes + '\n'
    ly += '  }\n'
    ly += '  \\layout {\n'
    ly += '    indent = 15\\mm\n'
    ly += '    \\context {\n'
    ly += '      \\Score\n'
    ly += '      \\override SpacingSpanner.common-shortest-duration = #(ly:make-moment 1/16)\n'
    ly += '      \\override SpacingSpanner.spacing-increment = #1.5\n'
    ly += '    }\n'
    ly += '  }\n'
    ly += '  \\midi { }\n'
    ly += '}\n'
    return ly

def build_piano_ly(song_title, inst_display, key_note, key_mode, tempo, rh_notes, lh_notes):
    ly = '\\version "2.26.0"\n'
    ly += '\\header {\n'
    ly += '  title = "' + song_title + '"\n'
    ly += '  subtitle = "' + inst_display + ' - Tempo: ' + str(tempo) + ' BPM"\n'
    ly += '  composer = "NoteFindr ile olusturuldu"\n'
    ly += '  tagline = ##f\n'
    ly += '}\n\n'
    ly += '\\paper {\n'
    ly += '  #(set-paper-size "a4")\n'
    ly += '  top-margin = 15\\mm\n'
    ly += '  bottom-margin = 15\\mm\n'
    ly += '  left-margin = 15\\mm\n'
    ly += '  right-margin = 15\\mm\n'
    ly += '  system-system-spacing.basic-distance = #20\n'
    ly += '}\n\n'
    ly += '\\score {\n'
    ly += '  \\new PianoStaff \\with { instrumentName = "Pno." } <<\n'
    ly += '    \\new Staff = "sag" {\n'
    ly += '      \\clef treble\n'
    ly += '      \\key ' + key_note + ' ' + key_mode + '\n'
    ly += '      \\tempo 4 = ' + str(tempo) + '\n'
    ly += '      \\time 4/4\n'
    ly += '      \\dynamicUp\n'
    ly += '      ' + rh_notes + '\n'
    ly += '    }\n'
    ly += '    \\new Staff = "sol" {\n'
    ly += '      \\clef bass\n'
    ly += '      \\key ' + key_note + ' ' + key_mode + '\n'
    ly += '      \\time 4/4\n'
    ly += '      ' + lh_notes + '\n'
    ly += '    }\n'
    ly += '  >>\n'
    ly += '  \\layout {\n'
    ly += '    indent = 15\\mm\n'
    ly += '    \\context {\n'
    ly += '      \\Score\n'
    ly += '      \\override SpacingSpanner.common-shortest-duration = #(ly:make-moment 1/16)\n'
    ly += '      \\override SpacingSpanner.spacing-increment = #1.8\n'
    ly += '    }\n'
    ly += '  }\n'
    ly += '  \\midi { }\n'
    ly += '}\n'
    return ly

# ─── Enstruman Donusumu (convert) ───
# Her hedef icin: mono (tek sesli mi -> skyline melodi) ve range (hedef perde araligi).
INSTRUMENT_PROFILES = {
    "piano":  {"mono": False, "range": None},        # grand staff, aralik genis
    "guitar": {"mono": False, "range": (40, 88)},    # E2-E6
    "saz":    {"mono": True,  "range": (50, 86)},    # D3-D6
    "violin": {"mono": True,  "range": (55, 100)},   # G3-E7
    "ud":     {"mono": True,  "range": (43, 85)},    # ~100-1100 Hz'in MIDI karsiligi (range = MIDI no)
}

def best_octave_shift(midis, lo, hi):
    """Melodiyi hedef aralige en iyi oturtan TEK oktav kaydirmasini bul
    (once aralik-ici nota sayisini maksimize et, sonra medyani aralik ortasina yaklastir)."""
    if not midis:
        return 0
    center = (lo + hi) / 2.0
    best = None
    for s in range(-36, 37, 12):
        shifted = [m + s for m in midis]
        inrange = sum(1 for m in shifted if lo <= m <= hi)
        med = sorted(shifted)[len(shifted) // 2]
        key = (inrange, -abs(med - center))
        if best is None or key > best[0]:
            best = (key, s)
    return best[1]

def _fit_to_range(notes, lo, hi):
    """Tum notalari TEK oktav kaydirmayla aralige tasi (kontur korunur);
    kalan tek tuk tasanlari per-nota oktav katlamayla duzelt."""
    if not notes:
        return notes
    shift = best_octave_shift([n["midi"] for n in notes], lo, hi)
    out = []
    for n in notes:
        m = n["midi"] + shift
        while m < lo:
            m += 12
        while m > hi:
            m -= 12
        nn = dict(n)
        nn["midi"] = m
        nn["note"] = hz_to_note_name(440.0 * (2.0 ** ((m - 69) / 12.0)))
        out.append(nn)
    return out

def _skyline_melody(notes, tempo):
    """Cok sesli notalardan tek melodi hatti: her olayin (quantize) en tiz notasi (skyline)."""
    events = quantize_notes(notes, tempo)
    mel = []
    for e in events:
        if e.get("is_rest") or not e.get("midis"):
            continue
        top = max(e["midis"])
        mel.append({
            "midi": top, "start": e["start"], "end": e["end"],
            "duration": e["duration"], "velocity": e.get("velocity", 80),
            "note": hz_to_note_name(440.0 * (2.0 ** ((top - 69) / 12.0))),
        })
    return mel

def convert_notes_for_target(notes, target, tempo):
    """Kaynak notalari hedef enstrumana uyarlar; generate_pdf'e hazir nota listesi doner.
    - mono (keman/saz): skyline melodi + aralik uyarlama
    - cok sesli (piyano/gitar): notalari koru; range varsa aralige uyarla
    generate_pdf DEGISMEZ - sadece ona dogru hazirlanmis notalar verilir."""
    prof = INSTRUMENT_PROFILES.get(target, INSTRUMENT_PROFILES["piano"])
    out = _skyline_melody(notes, tempo) if prof["mono"] else [dict(n) for n in notes]
    if prof["range"]:
        out = _fit_to_range(out, prof["range"][0], prof["range"][1])
    return out

# LilyPond'un bilinen sabit kurulum yolu (PATH'te ve .env'de yoksa son care)
_LILYPOND_FALLBACK = r"C:\Users\90553\Downloads\lilypond-2.26.0-mingw-x86_64\lilypond-2.26.0\bin\lilypond.exe"


def resolve_lilypond():
    """LilyPond calistirilabilirini su sirayla bul:
    1) .env LILYPOND_BIN (acikca verildiyse OTORITER: yoksa None -> anlamli hata, sessizce fallback YOK)
    2) PATH'teki 'lilypond'
    3) bilinen sabit kurulum yolu (_LILYPOND_FALLBACK)
    Bulunamazsa None doner (cagiran RuntimeError firlatir)."""
    env_bin = (os.getenv("LILYPOND_BIN") or "").strip().strip('"')
    if env_bin:
        cand = os.path.join(env_bin, "lilypond.exe") if os.path.isdir(env_bin) else env_bin
        return cand if os.path.exists(cand) else None
    which = shutil.which("lilypond")
    if which:
        return which
    if os.path.exists(_LILYPOND_FALLBACK):
        return _LILYPOND_FALLBACK
    return None


def generate_pdf(job_id, notes, tempo, key_name, key_idx, instrument, song_title="", key_is_major=True):
    inst_names = {"piano": "Piyano", "guitar": "Gitar", "saz": "Baglama / Saz", "violin": "Keman", "ud": "Ud"}
    inst_display = inst_names.get(instrument, "Piyano")
    if not song_title:
        song_title = "NoteFindr"
    if key_is_major:
        key_note, key_mode = KEY_SIGNATURES.get(key_idx, ("c", "\\major"))
    else:
        key_note, key_mode = KEY_SIGNATURES_MINOR.get(key_idx, ("a", "\\minor"))
    triplet_groups = detect_triplets(notes, tempo)
    triplet_set = set(triplet_groups)
    if instrument == "piano":
        if len(notes) > MAX_NOTES:
            print(f"UYARI: Nota tavanina carpildi ({len(notes)} -> {MAX_NOTES}), sarkinin sonu kesilecek!")
            notes = notes[:MAX_NOTES]
        right_hand, left_hand = improve_hand_separation(notes, tempo)
        right_hand = quantize_notes(right_hand, tempo)
        left_hand = quantize_notes(left_hand, tempo)
        # Iki eli de olculere bol; sag el melodi (slur'lu), sol el eslik (slur'suz daha temiz)
        rh_measures = render_voice_measures(right_hand, tempo, with_slurs=True)
        lh_measures = render_voice_measures(left_hand, tempo, with_slurs=False)
        # Olcu sayilarini esitle: kisa olan eli tam-olcu sus (r1) ile doldur -> grand staff hizali
        max_m = max(len(rh_measures), len(lh_measures))
        while len(rh_measures) < max_m:
            rh_measures.append(["r1"])
        while len(lh_measures) < max_m:
            lh_measures.append(["r1"])
        # Sag elin ilk gercek notasina \p dinamigi ekle
        for m in rh_measures:
            done = False
            for k, t in enumerate(m):
                if not t.startswith("r") and not t.startswith("\\"):
                    m[k] = t + "\\p"
                    done = True
                    break
            if done:
                break
        rh_notes = measures_to_lily(rh_measures) or "r1"
        lh_notes = measures_to_lily(lh_measures)
        lh_notes = ("\\sustainOn " + lh_notes) if lh_notes else "r1"
        lily_content = build_piano_ly(song_title, inst_display, key_note, key_mode, tempo, rh_notes, lh_notes)
    elif instrument == "guitar":
        if len(notes) > MAX_NOTES:
            print(f"UYARI: Nota tavanina carpildi ({len(notes)} -> {MAX_NOTES}), sarkinin sonu kesilecek!")
            notes = notes[:MAX_NOTES]
        q_notes = quantize_notes(notes, tempo)
        melody_notes = notes_to_lily_string(q_notes, tempo, triplet_set)
        lily_content = build_single_staff_ly(song_title, inst_display, "Gtr.", '"treble_8"', key_note, key_mode, tempo, melody_notes, "guitar")
    elif instrument == "saz":
        if len(notes) > MAX_NOTES:
            print(f"UYARI: Nota tavanina carpildi ({len(notes)} -> {MAX_NOTES}), sarkinin sonu kesilecek!")
            notes = notes[:MAX_NOTES]
        q_notes = quantize_notes(notes, tempo)
        melody_notes = notes_to_lily_string(q_notes, tempo, triplet_set)
        lily_content = build_single_staff_ly(song_title, inst_display, "Saz", "treble", key_note, key_mode, tempo, melody_notes, "saz")
    elif instrument == "ud":
        if len(notes) > MAX_NOTES:
            print(f"UYARI: Nota tavanina carpildi ({len(notes)} -> {MAX_NOTES}), sarkinin sonu kesilecek!")
            notes = notes[:MAX_NOTES]
        q_notes = quantize_notes(notes, tempo)
        melody_notes = notes_to_lily_string(q_notes, tempo, triplet_set)
        lily_content = build_single_staff_ly(song_title, inst_display, "Ud", "treble", key_note, key_mode, tempo, melody_notes, "ud")
    else:
        if len(notes) > MAX_NOTES:
            print(f"UYARI: Nota tavanina carpildi ({len(notes)} -> {MAX_NOTES}), sarkinin sonu kesilecek!")
            notes = notes[:MAX_NOTES]
        q_notes = quantize_notes(notes, tempo)
        melody_notes = notes_to_lily_string(q_notes, tempo, triplet_set)
        lily_content = build_single_staff_ly(song_title, inst_display, "Vln.", "treble", key_note, key_mode, tempo, melody_notes, "violin")
    lily_path = os.path.join(OUTPUT_DIR, f"{job_id}.ly")
    with open(lily_path, "w", encoding="utf-8") as f:
        f.write(lily_content)
    lily_bin = resolve_lilypond()
    if not lily_bin:
        print("LilyPond bulunamadi (LILYPOND_BIN / PATH / sabit yol) -> PDF uretilemedi.")
        raise RuntimeError("Nota kağıdı oluşturulamadı")
    try:
        result = subprocess.run(
            [lily_bin, "-o", os.path.join(OUTPUT_DIR, job_id), lily_path],
            capture_output=True, text=True, timeout=240,
        )
    except Exception as e:
        print(f"LilyPond calistirma hatasi: {e}")
        raise RuntimeError("Nota kağıdı oluşturulamadı")
    pdf_path = os.path.join(OUTPUT_DIR, f"{job_id}.pdf")
    if os.path.exists(pdf_path):
        return f"{job_id}.pdf"
    print(f"LilyPond stderr: {result.stderr[:500]}")
    raise RuntimeError("Nota kağıdı oluşturulamadı")
# ─── API Endpoints ───

@app.get("/health")
def health():
    return {"status": "healthy", "service": "NoteFindr API"}

def _ytdlp_error_detail(stderr):
    """yt-dlp stderr'inden GERCEK hata satirini cikar (uyari/nag satirlari detail'i gizlemesin).
    'ERROR' ile baslayan son satiri doner; yoksa son anlamli satiri."""
    lines = [ln.strip() for ln in (stderr or "").splitlines() if ln.strip()]
    errs = [ln for ln in lines if ln.upper().startswith("ERROR")]
    if errs:
        return errs[-1][:300]
    return (lines[-1][:300] if lines else "Bilinmeyen indirme hatasi")


# ffmpeg PATH'te olmayabilir; yt-dlp WAV'a cevirmek icin ffmpeg ister. Bilinen sabit kurulum:
_FFMPEG_FALLBACK_DIR = r"C:\ffmpeg\bin"


def resolve_ffmpeg_location():
    """yt-dlp icin ffmpeg KLASORUNU coz: 1) .env FFMPEG_LOCATION, 2) PATH'teki ffmpeg, 3) sabit C:\\ffmpeg\\bin.
    Bulunamazsa None (yt-dlp yine PATH'e bakar; yoksa anlamli 'ffmpeg not found' hatasi zaten yuzeye cikar)."""
    env = (os.getenv("FFMPEG_LOCATION") or "").strip().strip('"')
    if env:
        return env  # dizin ya da exe; yt-dlp ikisini de kabul eder
    which = shutil.which("ffmpeg")
    if which:
        return os.path.dirname(which)
    if os.path.exists(os.path.join(_FFMPEG_FALLBACK_DIR, "ffmpeg.exe")):
        return _FFMPEG_FALLBACK_DIR
    return None


@app.post("/api/v1/audio/from-link", response_model=LinkResponse)
def download_from_link(request: LinkRequest):
    job_id = str(uuid.uuid4())[:8]
    try:
        # yt-dlp exe PATH'te yok ama yt_dlp modulu ANA venv'de kurulu; sys.executable ile cagir.
        # --no-update: kendini guncelleme kontrolunu/nag uyarisini atla (stderr temiz kalsin).
        dl_cmd = [sys.executable, "-m", "yt_dlp", "--no-update", "--extract-audio", "--audio-format", "wav",
                  "--output", os.path.join(UPLOAD_DIR, f"{job_id}.%(ext)s"),
                  "--no-playlist", "--max-filesize", "50M",
                  "--js-runtimes", "node", "--remote-components", "ejs:github"]
        ff = resolve_ffmpeg_location()  # WAV donusumu ffmpeg ister; PATH'te yoksa acikca konum ver
        if ff:
            dl_cmd += ["--ffmpeg-location", ff]
        dl_cmd.append(request.url)
        result = subprocess.run(dl_cmd, capture_output=True, text=True, timeout=120)
        if result.returncode != 0:
            # Uyarilari (WARNING/nag) log'a; kullaniciya YALNIZ gercek ERROR satirini goster.
            print(f"yt-dlp stderr (tam):\n{result.stderr}")
            raise HTTPException(status_code=400, detail=f"İndirme başarısız: {_ytdlp_error_detail(result.stderr)}")
        actual_file = ""
        for f in os.listdir(UPLOAD_DIR):
            if f.startswith(job_id):
                actual_file = f
                break
        if not actual_file:
            raise HTTPException(status_code=500, detail="Dosya bulunamadi")
        # Video basligini al (ayri, hafif cagri; basarisiz olursa bos doner, indirmeyi etkilemez)
        title = ""
        try:
            tinfo = subprocess.run(
                [sys.executable, "-m", "yt_dlp", "--no-update", "--no-playlist", "--skip-download",
                 "--print", "%(title)s",
                 "--js-runtimes", "node", "--remote-components", "ejs:github",
                 request.url],
                capture_output=True, text=True, timeout=60,
            )
            if tinfo.returncode == 0 and tinfo.stdout.strip():
                title = tinfo.stdout.strip().splitlines()[0]
        except Exception as e:
            print(f"Baslik alma hatasi: {e}")
        return LinkResponse(job_id=job_id, status="downloaded", message="Ses dosyasi indirildi", filename=actual_file, title=title)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=408, detail="Zaman asimi")

@app.post("/api/v1/audio/upload", response_model=LinkResponse)
async def upload_audio(file: UploadFile = File(...)):
    job_id = str(uuid.uuid4())[:8]
    ext = file.filename.split(".")[-1] if "." in file.filename else "wav"
    filename = f"{job_id}.{ext}"
    filepath = os.path.join(UPLOAD_DIR, filename)
    contents = await file.read()
    if len(contents) > 50 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Dosya 50MB'dan buyuk olamaz")
    with open(filepath, "wb") as f:
        f.write(contents)
    # Yuklenen dosyanin adi (uzantisiz) baslik olur
    title = os.path.splitext(file.filename)[0] if file.filename else ""
    return LinkResponse(job_id=job_id, status="uploaded", message=f"'{file.filename}' yuklendi", filename=filename, title=title)

@app.post("/api/v1/transcription/transcribe", response_model=TranscribeResponse)
@app.post("/api/v1/transcribe/sync", response_model=TranscribeResponse)  # frontend gecisi icin senkron alias
def transcribe_audio(request: TranscribeRequest):
    wav_file = None
    for f in os.listdir(UPLOAD_DIR):
        if f.startswith(request.job_id):
            wav_file = os.path.join(UPLOAD_DIR, f)
            break
    if not wav_file or not os.path.exists(wav_file):
        raise HTTPException(status_code=404, detail="Ses dosyasi bulunamadi")
    try:
        # Demucs
        if request.use_demucs:
            analysis_file = separate_audio(wav_file, request.instrument)
        else:
            analysis_file = wav_file

        # Tempo ve anahtar (librosa)
        y, sr = librosa.load(analysis_file, sr=22050, mono=True)
        duration = librosa.get_duration(y=y, sr=sr)
        tempo = detect_tempo(y, sr)
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
        key_idx, key_is_major, key_name = detect_key(np.mean(chroma, axis=1))
        # Enstruman donusumu (convert) icin tempo/key'i diske sakla -> yeniden analiz gerekmesin
        try:
            with open(os.path.join(OUTPUT_DIR, f"{request.job_id}.meta.json"), "w", encoding="utf-8") as _mf:
                json.dump({"tempo": tempo, "key_idx": key_idx, "key_is_major": key_is_major,
                           "key_name": key_name, "instrument": request.instrument.value}, _mf)
        except Exception as _e:
            print(f"Meta yazma hatasi: {_e}")
        # PIYANO icin ozel ML modeli (en yuksek dogruluk)
        if request.instrument == "piano":
            piano_midi = run_piano_transcription(analysis_file, request.job_id)
            if piano_midi:
                piano_notes = read_midi_notes(piano_midi)
                if len(piano_notes) > 20:
                    print(f"Piyano ML basarili: {len(piano_notes)} nota")
                    notes = piano_notes
                    real_count = len(notes)  # kesme ONCESI gercek sayi (total_notes icin)
                    if len(notes) > MAX_NOTES:
                        print(f"UYARI: Nota tavanina carpildi ({len(notes)} -> {MAX_NOTES}), sarkinin sonu kesilecek!")
                        notes = notes[:MAX_NOTES]
                    # NOT: Burada quantize ETMIYORUZ. generate_pdf icinde once el ayrimi
                    # (gercek onset zamanlariyla akor gruplama) sonra tek sefer quantize yapilir.
                    # Burada quantize edilirse onset zamanlari bozulur, el ayrimi/akor gruplama kayar.
                    midi_out = os.path.join(OUTPUT_DIR, f"{request.job_id}.mid")
                    shutil.copy2(piano_midi, midi_out)
                    # Zengin ham ML MIDI'sini ayrica sakla; LilyPond {job_id}.mid'i skor MIDI'siyle ezer.
                    shutil.copy2(piano_midi, os.path.join(OUTPUT_DIR, f"{request.job_id}_full.mid"))
                    pdf_file = generate_pdf(request.job_id, notes, tempo, key_name, key_idx, request.instrument, key_is_major=key_is_major)
                    return TranscribeResponse(
                        job_id=request.job_id, status="completed", tempo=tempo, key=key_name,
                        total_notes=real_count, duration_seconds=round(duration, 2),
                        notes=notes[:50], midi_file=f"{request.job_id}.mid", pdf_file=pdf_file,
                    )
        # ONCELIK: Basic-pitch
        bp_midi = run_basic_pitch(analysis_file, request.job_id, request.instrument)
        if bp_midi:
            # Saz ve keman MONOFONIK -> tek-nota cikarma (hayalet harmonik/akor elenir).
            # Gitar polifonik -> varsayilan (3 nota). Piyano bu yola hic girmez (ayri ML).
            inst_val = request.instrument.value if hasattr(request.instrument, "value") else str(request.instrument)
            bp_notes = read_midi_notes(bp_midi, monophonic=(inst_val in ("saz", "violin", "ud")),
                                       midi_range=INSTRUMENT_MIDI_RANGE.get(inst_val))
            if len(bp_notes) > 20:
                print(f"Basic-pitch basarili: {len(bp_notes)} nota")
                notes = bp_notes
                real_count = len(notes)  # kesme ONCESI gercek sayi (total_notes icin)
                if len(notes) > MAX_NOTES:
                    print(f"UYARI: Nota tavanina carpildi ({len(notes)} -> {MAX_NOTES}), sarkinin sonu kesilecek!")
                    notes = notes[:MAX_NOTES]
                # Quantize generate_pdf icinde tek sefer yapilir (cift quantize olaylari bozar)
                midi_out = os.path.join(OUTPUT_DIR, f"{request.job_id}.mid")
                shutil.copy2(bp_midi, midi_out)
                # Zengin ham basic-pitch MIDI'sini ayrica sakla; LilyPond {job_id}.mid'i ezer.
                shutil.copy2(bp_midi, os.path.join(OUTPUT_DIR, f"{request.job_id}_full.mid"))
                pdf_file = generate_pdf(request.job_id, notes, tempo, key_name, key_idx, request.instrument, key_is_major=key_is_major)
                return TranscribeResponse(
                    job_id=request.job_id, status="completed", tempo=tempo, key=key_name,
                    total_notes=real_count, duration_seconds=round(duration, 2),
                    notes=notes[:50], midi_file=f"{request.job_id}.mid", pdf_file=pdf_file,
                )

        # YEDEK: librosa — basic-pitch yetersiz/yok. Nedenini logla (teshis icin):
        if bp_midi is None:
            print("Basic-pitch basarisiz: MIDI uretilemedi -> librosa kullaniliyor")
        else:
            print(f"Basic-pitch yetersiz: {len(bp_notes)} nota (esik 20) -> librosa kullaniliyor")
        pitches, magnitudes = librosa.piptrack(y=y, sr=sr, hop_length=512, threshold=0.05)
        onset_frames = librosa.onset.onset_detect(
            y=y, sr=sr, hop_length=512, backtrack=True, units='frames',
            pre_max=3, post_max=3, pre_avg=3, post_avg=5, delta=0.03, wait=3
        )
        onset_times = librosa.frames_to_time(onset_frames, sr=sr, hop_length=512)
        # Librosa yedeginde de enstruman-ozel MIDI araligi (yoksa genel 21-108 = piyano)
        _iv = request.instrument.value if hasattr(request.instrument, "value") else str(request.instrument)
        lib_range = INSTRUMENT_MIDI_RANGE.get(_iv, (21, 108))
        notes = []
        for i, onset_frame in enumerate(onset_frames):
            search_end = min(onset_frame + 8, pitches.shape[1])
            best_pitch = 0
            best_mag = 0
            for frame in range(onset_frame, search_end):
                idx = magnitudes[:, frame].argmax()
                if magnitudes[idx, frame] > best_mag:
                    best_mag = magnitudes[idx, frame]
                    best_pitch = pitches[idx, frame]
            if best_pitch < 65 or best_mag < 0.05:
                continue
            if i + 1 < len(onset_times):
                note_duration = onset_times[i + 1] - onset_times[i]
            else:
                note_duration = min(duration - onset_times[i], 2.0)
            if note_duration < 0.04:
                continue
            note_duration = min(note_duration, 4.0)
            midi_num = hz_to_midi(best_pitch)
            if not (lib_range[0] <= midi_num <= lib_range[1]):
                continue
            notes.append({"note": hz_to_note_name(best_pitch), "midi": midi_num,
                          "start": round(onset_times[i], 3), "end": round(onset_times[i] + note_duration, 3),
                          "duration": round(note_duration, 3)})
        notes.sort(key=lambda x: x["start"])
        # BOS/YETERSIZ KAYIT KAPISI: buraya yalniz basic-pitch yetersizken (<=20 nota) gelinir.
        # Kayit cok sessizse (dusuk RMS) VEYA librosa da cok az nota bulduysa -> PDF uretme, reddet.
        # ASIL kapi RMS: sessiz kayitta librosa hayalet nota uretebiliyor (35), nota sayisi tek basina yetmez.
        rec_rms = float(np.sqrt(np.mean(y ** 2))) if len(y) else 0.0
        if rec_rms < 0.01 or len(notes) < 5:
            print(f"Yetersiz kayit reddedildi: RMS={rec_rms:.4f} (~{20*np.log10(rec_rms+1e-12):.0f} dBFS), librosa nota={len(notes)}")
            raise HTTPException(status_code=422, detail="Kayıtta yeterli müzik algılanamadı. Daha net ve uzun bir kayıt deneyin.")
        # Quantize generate_pdf icinde tek sefer yapilir; MIDI ham (gercek zamanli) notalardan uretilir
        real_count = len(notes)  # kesme ONCESI gercek sayi (total_notes icin)
        if len(notes) > MAX_NOTES:
            print(f"UYARI: Nota tavanina carpildi ({len(notes)} -> {MAX_NOTES}), sarkinin sonu kesilecek!")
            notes = notes[:MAX_NOTES]
        midi_obj = MIDIFile(1)
        midi_obj.addTempo(0, 0, tempo)
        for n in notes:
            midi_obj.addNote(0, 0, n["midi"], n["start"] * (tempo / 60.0), max(n["duration"] * (tempo / 60.0), 0.25), 100)
        midi_path = os.path.join(OUTPUT_DIR, f"{request.job_id}.mid")
        with open(midi_path, "wb") as mf:
            midi_obj.writeFile(mf)
        # Zengin ham MIDI'yi ayrica sakla; LilyPond {job_id}.mid'i skor MIDI'siyle ezer.
        shutil.copy2(midi_path, os.path.join(OUTPUT_DIR, f"{request.job_id}_full.mid"))
        pdf_file = generate_pdf(request.job_id, notes, tempo, key_name, key_idx, request.instrument, key_is_major=key_is_major)
        return TranscribeResponse(
            job_id=request.job_id, status="completed", tempo=tempo, key=key_name,
            total_notes=real_count, duration_seconds=round(duration, 2),
            notes=notes[:50], midi_file=f"{request.job_id}.mid", pdf_file=pdf_file,
        )
    except HTTPException:
        raise  # 422 gibi anlamli hatalar (yetersiz kayit) oldugu gibi gitsin, 500'e cevrilmesin
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Analiz hatasi: {str(e)[:300]}")

def _resp_dict(resp):
    """TranscribeResponse -> dict (job result_json icin). pydantic v1/v2 uyumlu."""
    if hasattr(resp, "model_dump"):
        return resp.model_dump()
    if hasattr(resp, "dict"):
        return resp.dict()
    return dict(resp)


@app.post("/api/v1/omr/from-photo", status_code=202)
def omr_from_photo(request: OmrRequest):
    """Basili nota FOTOGRAFINDAN nota cikarir (OMR). oemer YAVAS (dakikalar) -> ARKA PLAN job.
    Hemen 202 + {job_id, status:'queued'} doner; ilerleme/sonuc GET /api/v1/jobs/{job_id}.
    done ise result = TranscribeResponse sekli (PDF/indirme akisi AYNEN)."""
    # Yuklenen goruntuyu bul (sadece jpg/jpeg/png) — hizli 4xx enqueue ONCESI
    image_path = ""
    for ext in ("jpg", "jpeg", "png"):
        p = os.path.join(UPLOAD_DIR, f"{request.job_id}.{ext}")
        if os.path.exists(p):
            image_path = p
            break
    if not image_path:
        any_file = [f for f in os.listdir(UPLOAD_DIR) if f.startswith(request.job_id)]
        if any_file:
            raise HTTPException(status_code=400, detail="Sadece JPG/JPEG/PNG nota fotografi desteklenir.")
        raise HTTPException(status_code=404, detail="Yuklenen foto bulunamadi.")

    instrument = request.instrument
    job_id = request.job_id
    jobs.create_job(job_id, "omr")

    def work(prog):
        from omr import omr_to_notes, validate_sheet_image  # lazy import -> dairesel import yok
        prog(5, "Gorsel dogrulaniyor")
        validate_sheet_image(image_path)  # boyut + porte on-kontrolu (reddederse anlamli 4xx)
        stop_tick = jobs.make_ticker(job_id, est=OMR_EST_SEC, lo=15, hi=85)  # oemer icin zaman-tabanli kaba ilerleme
        try:
            notes, tempo, key_name, key_idx, key_is_major, cached = omr_to_notes(
                image_path, job_id, progress_cb=prog)
        finally:
            stop_tick()
        prog(93, "Nota kagidi olusturuluyor")
        pdf_file = generate_pdf(job_id, notes, tempo, key_name, key_idx,
                                instrument, key_is_major=key_is_major)
        duration = max((n["end"] for n in notes), default=0.0)
        return {
            "job_id": job_id, "status": "completed", "tempo": tempo, "key": key_name,
            "total_notes": len(notes), "duration_seconds": round(duration, 2),
            "notes": notes[:50], "midi_file": f"{job_id}.mid", "pdf_file": pdf_file, "cached": cached,
        }

    jobs.submit(job_id, work)
    return {"job_id": job_id, "status": "queued"}


@app.post("/api/v1/transcribe", status_code=202)
def transcribe_async(request: TranscribeRequest):
    """Ses transkripsiyonunu ARKA PLAN job olarak calistir. Hemen 202 + job_id.
    Ilerleme/sonuc GET /api/v1/jobs/{job_id}. Senkron davranis: /api/v1/transcribe/sync."""
    job_id = request.job_id
    jobs.create_job(job_id, "transcribe")

    def work(prog):
        prog(15, "Ses isleniyor")
        stop_tick = jobs.make_ticker(job_id, est=TRANSCRIBE_EST_SEC, lo=15, hi=90)
        try:
            resp = transcribe_audio(request)  # mevcut senkron mantik (IC MANTIK DEGISMEDI)
        finally:
            stop_tick()
        prog(95, "Nota kagidi olusturuluyor")
        return _resp_dict(resp)

    jobs.submit(job_id, work)
    return {"job_id": job_id, "status": "queued"}


@app.get("/api/v1/jobs/{job_id}")
def get_job_status(job_id: str):
    """Arka plan is durumu. Doner: {status, progress, message, [error], [result]}.
    done -> result = TranscribeResponse sekli (frontend bekleme ekrani buradan beslenir)."""
    j = jobs.get_job(job_id)
    if not j:
        raise HTTPException(status_code=404, detail="Is bulunamadi.")
    out = {"job_id": j["job_id"], "kind": j["kind"], "status": j["status"],
           "progress": j["progress"], "message": j["message"]}
    if j.get("error"):
        out["error"] = j["error"]
    if j["status"] == "done" and j.get("result") is not None:
        out["result"] = j["result"]
    return out

@app.post("/api/v1/transcription/convert", response_model=ConvertResponse)
def convert_instrument(request: ConvertRequest):
    """Mevcut bir job'un cikardigi notalari BASKA bir enstrumana uyarlar (yeniden ML/ses analizi YOK).
    Notalar {job_id}_full.mid'den okunur; tempo/key sidecar'dan (yoksa sesten yeniden hesaplanir)."""
    target = request.target_instrument.value if hasattr(request.target_instrument, "value") else str(request.target_instrument)
    if target not in INSTRUMENT_PROFILES:
        raise HTTPException(status_code=400, detail=f"Gecersiz hedef enstruman: {target}")
    full_mid = os.path.join(OUTPUT_DIR, f"{request.job_id}_full.mid")
    if not os.path.exists(full_mid):
        raise HTTPException(status_code=404, detail="Orijinal nota verisi (_full.mid) bulunamadi. Once transcribe calistirin.")
    notes = read_midi_notes(full_mid)
    if not notes:
        raise HTTPException(status_code=422, detail="Nota okunamadi")

    # Tempo/key: once sidecar (hizli), yoksa orijinal sesten yeniden hesapla (ML degil)
    tempo, key_idx, key_is_major, key_name = 100, 0, True, "Do Major"
    meta_path = os.path.join(OUTPUT_DIR, f"{request.job_id}.meta.json")
    if os.path.exists(meta_path):
        try:
            with open(meta_path, encoding="utf-8") as mf:
                meta = json.load(mf)
            tempo = int(meta.get("tempo", tempo))
            key_idx = int(meta.get("key_idx", key_idx))
            key_is_major = bool(meta.get("key_is_major", key_is_major))
            key_name = meta.get("key_name", key_name)
        except Exception as e:
            print(f"Meta okuma hatasi: {e}")
    else:
        wav = None
        for f in os.listdir(UPLOAD_DIR):
            if f.startswith(request.job_id):
                wav = os.path.join(UPLOAD_DIR, f)
                break
        if wav and os.path.exists(wav):
            try:
                y, sr = librosa.load(wav, sr=22050, mono=True)
                tempo = detect_tempo(y, sr)
                chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
                key_idx, key_is_major, key_name = detect_key(np.mean(chroma, axis=1))
            except Exception as e:
                print(f"Convert fallback tempo/key hatasi: {e}")

    adapted = convert_notes_for_target(notes, target, tempo)
    out_job = f"{request.job_id}_{target}"
    # Uyarlanmis notalardan zengin MIDI sakla -> /download/{out_job}/midi
    try:
        midi_obj = MIDIFile(1)
        midi_obj.addTempo(0, 0, tempo)
        for n in adapted:
            midi_obj.addNote(0, 0, n["midi"], max(n["start"] * (tempo / 60.0), 0),
                             max(n["duration"] * (tempo / 60.0), 0.25), n.get("velocity", 90))
        with open(os.path.join(OUTPUT_DIR, f"{out_job}_full.mid"), "wb") as mf:
            midi_obj.writeFile(mf)
    except Exception as e:
        print(f"Convert MIDI yazma hatasi: {e}")

    pdf_file = generate_pdf(out_job, adapted, tempo, key_name, key_idx, target, key_is_major=key_is_major)
    return ConvertResponse(
        source_job_id=request.job_id, target_instrument=target, out_job_id=out_job,
        pdf_file=pdf_file, midi_file=f"{out_job}.mid", total_notes=len(adapted),
        notes=adapted[:50],
    )

@app.get("/api/v1/download/{job_id}/pdf")
def download_pdf(job_id: str):
    pdf_path = os.path.join(OUTPUT_DIR, f"{job_id}.pdf")
    if not os.path.exists(pdf_path):
        raise HTTPException(status_code=404, detail="PDF bulunamadi")
    return FileResponse(pdf_path, media_type="application/pdf", filename=f"NoteFindr_{job_id}.pdf")

@app.get("/api/v1/download/{job_id}/midi")
def download_midi(job_id: str):
    # Varsayilan olarak ZENGIN ham transkripsiyon MIDI'sini ver ({job_id}_full.mid).
    # Yoksa skor MIDI'sine ({job_id}.mid, LilyPond render'i) dus.
    full_path = os.path.join(OUTPUT_DIR, f"{job_id}_full.mid")
    score_path = os.path.join(OUTPUT_DIR, f"{job_id}.mid")
    path = full_path if os.path.exists(full_path) else score_path
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="MIDI bulunamadi")
    return FileResponse(path, media_type="audio/midi", filename=f"NoteFindr_{job_id}.mid")

@app.get("/api/v1/download/{job_id}/midi/full")
def download_midi_full(job_id: str):
    # Acikca zengin ham transkripsiyon MIDI'si (tum notalar, quantize edilmemis).
    full_path = os.path.join(OUTPUT_DIR, f"{job_id}_full.mid")
    if not os.path.exists(full_path):
        raise HTTPException(status_code=404, detail="Tam MIDI bulunamadi")
    return FileResponse(full_path, media_type="audio/midi", filename=f"NoteFindr_{job_id}_full.mid")

@app.get("/api/v1/download/{job_id}/midi/score")
def download_midi_score(job_id: str):
    # Notaya birebir uyan (quantize/capped) skor MIDI'si - LilyPond \midi ciktisi.
    score_path = os.path.join(OUTPUT_DIR, f"{job_id}.mid")
    if not os.path.exists(score_path):
        raise HTTPException(status_code=404, detail="Skor MIDI bulunamadi")
    return FileResponse(score_path, media_type="audio/midi", filename=f"NoteFindr_{job_id}_score.mid")

@app.get("/api/v1/audio/files")
def list_files():
    return {"files": os.listdir(UPLOAD_DIR), "count": len(os.listdir(UPLOAD_DIR))}

@app.get("/api/v1/instruments")
def list_instruments():
    return {"instruments": [
        {"id": "piano", "name": "Piyano", "range": ["A0", "C8"]},
        {"id": "guitar", "name": "Gitar", "range": ["E2", "E6"]},
        {"id": "saz", "name": "Saz", "range": ["D3", "D6"]},
        {"id": "violin", "name": "Keman", "range": ["G3", "E7"]},
        {"id": "ud", "name": "Ud", "range": ["G2", "D6"]},
    ]}
