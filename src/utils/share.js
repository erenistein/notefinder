// Ortak indirme + paylasim yardimcisi.
// SDK 54 YENI filesystem API'si (File/Paths) - legacy FileSystem.downloadAsync KULLANILMAZ
// (legacy SDK 55'te kalkiyor ve bazi durumlarda runtime hatasi veriyor).
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { Linking, Alert } from "react-native";
import i18n from "../i18n"; // non-component -> i18n instance dogrudan

function mimeFor(filename) {
  if (filename.toLowerCase().endsWith(".pdf")) return { mimeType: "application/pdf", UTI: "com.adobe.pdf" };
  if (filename.toLowerCase().endsWith(".mid")) return { mimeType: "audio/midi", UTI: "public.midi-audio" };
  return {};
}

// url'deki dosyayi cache'e indir, sonra native paylas menusunu ac.
// Web'de / paylasim yoksa: tarayicida ac (fallback). Hata olursa nazik Alert, cokmez.
export async function downloadAndShare(url, filename) {
  try {
    const canShare = await Sharing.isAvailableAsync();
    if (!canShare) {
      // Web ya da paylasim desteklenmiyor -> dogrudan tarayicida ac (indir)
      await Linking.openURL(url);
      return true;
    }

    // Native: cache altina belirli adla indir. Ayni ad varsa once sil (yeniden-indirme hatasini onle).
    const target = new File(Paths.cache, filename);
    try {
      if (target.exists) target.delete();
    } catch (e) {
      // silme onemsiz; downloadFileAsync yine de deneyecek
    }
    const output = await File.downloadFileAsync(url, target);
    const localUri = (output && output.uri) || target.uri;

    await Sharing.shareAsync(localUri, mimeFor(filename));
    return true;
  } catch (e) {
    console.warn("downloadAndShare hatasi:", e);
    Alert.alert(i18n.t("share.failTitle"), i18n.t("share.failBody"));
    return false;
  }
}
