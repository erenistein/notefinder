// Timestamp (ms) -> "az önce / 5 dakika önce / dün / 3 gün önce ..." (aktif dile gore).
// date.js bir React bileseni DEGIL -> hook kullanamaz; i18n instance'ini dogrudan cagiririz.
// Cagiran ekranlar (History/Home) useTranslation ile re-render oldugundan dil degisince
// bu fonksiyon yeniden calisir ve i18n.t o anki dili verir. Cogul + {{count}} i18next uzerinden.
import i18n from "../i18n";

export function formatRelativeDate(ts) {
  if (!ts) return "";
  const diff = Math.max(0, Date.now() - ts);
  const min = Math.floor(diff / 60000);
  const hr = Math.floor(diff / 3600000);
  const day = Math.floor(diff / 86400000);
  if (min < 1) return i18n.t("date.justNow");
  if (min < 60) return i18n.t("date.minutesAgo", { count: min });
  if (hr < 24) return i18n.t("date.hoursAgo", { count: hr });
  if (day === 1) return i18n.t("date.yesterday");
  if (day < 7) return i18n.t("date.daysAgo", { count: day });
  if (day < 30) return i18n.t("date.weeksAgo", { count: Math.floor(day / 7) });
  const mon = Math.floor(day / 30);
  if (mon < 12) return i18n.t("date.monthsAgo", { count: mon });
  return i18n.t("date.yearsAgo", { count: Math.floor(day / 365) });
}

// Saniye -> "m:ss" (sure gosterimi) - dilden bagimsiz, cevrilmez.
export function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
