"""
OMR ikinci yol: gorsel LLM -> ABC notasyonu -> music21 -> notes. oemer'e alternatif.
Saglayici .env'den OMR_LLM_PROVIDER=openai|anthropic (yoksa hangi anahtar varsa o).
API anahtarlari .env'den (OPENAI_API_KEY / ANTHROPIC_API_KEY) — hardcode YOK, .env gitignore'da.
Frontend'e dokunulmaz; omr.py ile AYNI donus imzasi.
"""
import os
import base64
from fastapi import HTTPException
from dotenv import load_dotenv

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BACKEND_DIR, ".env"))

OUTPUT_DIR = "outputs"
OPENAI_MODEL = "gpt-4o"                 # gorsel destekli
ANTHROPIC_MODEL = "claude-sonnet-4-6"   # ileride
LAST_USAGE = {}  # {input, output, provider, model} — maliyet olcumu icin

_SYSTEM = (
    "Bir muzik ogretmenine yardim ediyorsun: elindeki basili nota sayfasini ogrenciler icin ABC "
    "notasyonuna dijitallestiriyorsun. Goruntudeki porte uzerindeki notalari oku ve ABC olarak yaz. "
    "Gordugunu en iyi tahminle yaz; kusursuz olmasi gerekmez, bir taslak yeterli. "
    "Cikti dogrudan 'X:1' ile baslasin: X:1, T:, M:, L:, K: basliklari + notalar, olcu cizgileri, tekrarlar. "
    "Sadece porte ustundeki notalari ve suslari yaz; hece/soz, akor isimleri, parmak-tel numaralari, "
    "mizrap oklari ve arayuz ogelerini yok say. Aciklama veya ozur yazma, sadece ABC ver."
)
_USER = "Lutfen bu nota sayfasini ABC notasyonuna cevir. Dogrudan 'X:1' satiriyla basla."


def _media_type(path):
    p = path.lower()
    if p.endswith(".png"):
        return "image/png"
    if p.endswith(".webp"):
        return "image/webp"
    if p.endswith(".gif"):
        return "image/gif"
    return "image/jpeg"


def _b64(path):
    with open(path, "rb") as f:
        return base64.standard_b64encode(f.read()).decode("utf-8")


def provider():
    """OMR_LLM_PROVIDER (openai|anthropic); yoksa anahtari olan; ikisi de yoksa openai."""
    p = os.getenv("OMR_LLM_PROVIDER", "").strip().lower()
    if p in ("openai", "anthropic"):
        return p
    if os.getenv("OPENAI_API_KEY"):
        return "openai"
    if os.getenv("ANTHROPIC_API_KEY"):
        return "anthropic"
    return "openai"


def _strip_fences(txt):
    txt = (txt or "").strip()
    if "```" in txt:
        txt = "\n".join(ln for ln in txt.splitlines() if not ln.strip().startswith("```")).strip()
    return txt


def _openai_abc(image_path):
    from openai import OpenAI
    key = os.getenv("OPENAI_API_KEY")
    if not key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY tanimli degil (.env).")
    client = OpenAI(api_key=key)
    data_url = f"data:{_media_type(image_path)};base64,{_b64(image_path)}"
    resp = client.chat.completions.create(
        model=OPENAI_MODEL,
        max_tokens=4000,
        messages=[
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": [
                {"type": "text", "text": _USER},
                {"type": "image_url", "image_url": {"url": data_url}},
            ]},
        ],
    )
    global LAST_USAGE
    LAST_USAGE = {"input": resp.usage.prompt_tokens, "output": resp.usage.completion_tokens,
                  "provider": "openai", "model": OPENAI_MODEL}
    return _strip_fences(resp.choices[0].message.content)


def _anthropic_abc(image_path):
    import anthropic
    key = os.getenv("ANTHROPIC_API_KEY")
    if not key:
        raise HTTPException(status_code=500, detail="ANTHROPIC_API_KEY tanimli degil (.env).")
    client = anthropic.Anthropic(api_key=key)
    resp = client.messages.create(
        model=ANTHROPIC_MODEL,
        max_tokens=4000,
        system=_SYSTEM,
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": _media_type(image_path), "data": _b64(image_path)}},
            {"type": "text", "text": _USER},
        ]}],
    )
    global LAST_USAGE
    LAST_USAGE = {"input": resp.usage.input_tokens, "output": resp.usage.output_tokens,
                  "provider": "anthropic", "model": ANTHROPIC_MODEL}
    return _strip_fences("".join(b.text for b in resp.content if b.type == "text"))


def llm_image_to_abc(image_path):
    """Gorseli secili saglayiciya gonderip ABC metni dondurur. Token'lar LAST_USAGE'a yazilir."""
    return _openai_abc(image_path) if provider() == "openai" else _anthropic_abc(image_path)


def omr_llm_to_notes(image_path, job_id):
    """Foto -> (notes, tempo, key_name, key_idx, key_is_major) — omr.py ile ayni imza."""
    from music21 import converter, tempo as m21tempo
    from main import read_midi_notes, NOTE_NAMES  # lazy -> dairesel import yok

    abc = llm_image_to_abc(image_path)
    abc_path = os.path.join(OUTPUT_DIR, f"omr_llm_{job_id}.abc")
    with open(abc_path, "w", encoding="utf-8") as f:
        f.write(abc)
    try:
        score = converter.parse(abc_path)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"LLM'in urettigi nota (ABC) okunamadi: {str(e)[:120]}")

    marks = list(score.recurse().getElementsByClass(m21tempo.MetronomeMark))
    bpm = 120
    for mk in marks:
        if mk.number:
            bpm = int(round(mk.number)); break
    if not marks:
        score.insert(0, m21tempo.MetronomeMark(number=bpm))
    key_idx, key_is_major = 0, True
    try:
        k = score.analyze("key")
        key_idx = int(k.tonic.pitchClass); key_is_major = (k.mode == "major")
    except Exception:
        pass
    key_name = NOTE_NAMES[key_idx] + (" Major" if key_is_major else " Minor")

    midi = os.path.join(OUTPUT_DIR, f"{job_id}_full.mid")
    score.write("midi", fp=midi)
    notes = read_midi_notes(midi, monophonic=False, midi_range=None)
    if not notes:
        raise HTTPException(status_code=422, detail="LLM sonucundan gecerli nota cikmadi.")
    return notes, bpm, key_name, key_idx, key_is_major
