// Arka plan is (job) servisi: async transcribe/OMR baslatma + durum polleme.
// Backend sozlesmesi:
//   POST /api/v1/transcribe        -> 202 { job_id, status:"queued" }
//   POST /api/v1/omr/from-photo    -> 202 { job_id, status:"queued" }
//   GET  /api/v1/jobs/{job_id}     -> { status, progress, message, [error], [result] }
//     status: queued|running|done|failed ; done -> result = TranscribeResponse sekli.
import { API } from "../constants";
import { getJobs, saveJob } from "../utils/storage";

const BASE = API.BASE_URL;

// Ortak async-job baslatma: 202 bekler, job_id doner. Hata -> backend'in Turkce detail'iyle Error.
async function startJob(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status !== 202) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Beklenmeyen sunucu yaniti (${res.status})`);
  }
  const data = await res.json().catch(() => ({}));
  if (!data.job_id) throw new Error("Sunucu is kimligi (job_id) dondurmedi");
  return data.job_id;
}

// Ses transkripsiyonunu arka planda baslat. job_id doner (girdi jobId ile ayni).
export function startTranscribe(jobId, instrument, useDemucs = true) {
  return startJob("/api/v1/transcribe", { job_id: jobId, instrument, use_demucs: useDemucs });
}

// Foto OMR'yi arka planda baslat. job_id doner. (Foto onceden /audio/upload ile yuklenmis olmali.)
export function startOmr(jobId, instrument) {
  return startJob("/api/v1/omr/from-photo", { job_id: jobId, instrument });
}

// Tek seferlik durum sorgusu. Basarili -> { status, progress, message, result?, error? }; hata -> null.
export async function getJob(jobId) {
  try {
    const res = await fetch(`${BASE}/api/v1/jobs/${jobId}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

// Job done|failed olana kadar POLL et. onTick(job) her basarili sorguda cagrilir.
// stopRef.stopped true olunca durur (ekran unmount / iptal) -> null doner.
// Doner: son job nesnesi (status done|failed) veya durdurulduysa null.
export async function pollJob(jobId, { onTick, intervalMs = 5000, stopRef } = {}) {
  while (!(stopRef && stopRef.stopped)) {
    const job = await getJob(jobId);
    if (job) {
      if (onTick) onTick(job);
      if (job.status === "done" || job.status === "failed") return job;
    }
    // sonraki sorguya kadar bekle (durdurulmus olabilir -> donguye don kontrol et)
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

// Job durum sonucunu (result) yerel kayit alanlarina cevir.
function resultToRecord(jobId, base, result) {
  const r = result || {};
  return {
    jobId, title: base.title, instrument: base.instrument,
    tempo: r.tempo, key: r.key, totalNotes: r.total_notes, duration: r.duration_seconds,
    hasPdf: !!r.pdf_file, status: "done",
  };
}

// Yerel "processing" kayitlarini backend'den kontrol et; biten/basarisiz olanlari guncelle.
// Kullanici bekleme ekranindan ayrilsa bile Home/History odaklaninca durum senkron kalir.
// Doner: en az bir kayit degistiyse true.
export async function reconcileProcessingJobs() {
  let changed = false;
  const list = await getJobs();
  for (const j of list) {
    if (j.status !== "processing") continue;
    const job = await getJob(j.jobId);
    if (!job) continue;
    if (job.status === "done") {
      await saveJob(resultToRecord(j.jobId, j, job.result));
      changed = true;
    } else if (job.status === "failed") {
      await saveJob({ jobId: j.jobId, status: "failed" });
      changed = true;
    }
  }
  return changed;
}
