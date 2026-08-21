// Cihazda kalici is (job) gecmisi - AsyncStorage uzerinde tek bir liste olarak tutulur.
// Tum fonksiyonlar hata durumunda cokmez (try/catch), guvenli varsayilan doner.
import AsyncStorage from "@react-native-async-storage/async-storage";
import i18n from "../i18n"; // fallback baslik cevirisi icin (non-component)

const STORAGE_KEY = "notefindr_jobs";

// Tum kayitlari oku (yeni -> eski sirali). Hata/bos ise [] doner.
export async function getJobs() {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    console.warn("getJobs hatasi:", e);
    return [];
  }
}

// Bir is kaydini ekle/guncelle. Ayni jobId varsa gunceller; yoksa basa ekler (en yeni ustte).
// Beklenen alanlar: jobId, title, instrument, tempo, key, totalNotes, duration, hasPdf, createdAt
export async function saveJob(job) {
  try {
    if (!job || !job.jobId) return false;
    const list = await getJobs();
    const record = { createdAt: Date.now(), ...job };
    const idx = list.findIndex((j) => j.jobId === job.jobId);
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...record };
    } else {
      list.unshift(record);
    }
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch (e) {
    console.warn("saveJob hatasi:", e);
    return false;
  }
}

// Bir is kaydini Result ekraninin okudugu TAM param setine cevirir (camelCase).
// Hem History hem Home buradan beslenir -> tek kaynak. notes kayitta yok (bos dizi).
// pdfFile: Result hasPdf'i !!pdfFile'dan turetiyor; hasPdf true ise truthy bir deger geciyoruz.
export function jobToResultParams(job) {
  return {
    jobId: job.jobId,
    title: job.title || i18n.t("home.unknownSong"),
    instrument: job.instrument || "piano",
    tempo: job.tempo || 0,
    key: job.key || "",
    totalNotes: job.totalNotes || 0,
    duration: job.duration || 0,
    pdfFile: job.hasPdf ? `${job.jobId}.pdf` : "",
    notes: [],
  };
}

// Bir kaydi jobId ile sil.
export async function deleteJob(jobId) {
  try {
    const list = await getJobs();
    const next = list.filter((j) => j.jobId !== jobId);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return true;
  } catch (e) {
    console.warn("deleteJob hatasi:", e);
    return false;
  }
}
