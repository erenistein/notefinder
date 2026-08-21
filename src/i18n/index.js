// i18n kurulumu: cihaz dili (languageCode) -> desteklenirse onu, degilse en.
// Elle secim (AsyncStorage: notefindr_lang) cihaz dilini ezer. Fallback: en.
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import * as Localization from "expo-localization";
import AsyncStorage from "@react-native-async-storage/async-storage";
import tr from "./tr.json";
import en from "./en.json";

export const LANGUAGE_KEY = "notefindr_lang";
export const SUPPORTED = ["tr", "en"];
export const FALLBACK = "en";

// Cihazin birincil dil kodu (orn. "tr", "en", "fr"). Desteklemiyorsak fallback.
function deviceLanguage() {
  let code;
  try {
    code = Localization.getLocales?.()[0]?.languageCode;
  } catch (e) {
    code = null;
  }
  return SUPPORTED.includes(code) ? code : FALLBACK;
}

// i18next senkron baslar (uygulama hemen render olsun) -> once cihaz dili.
i18n.use(initReactI18next).init({
  resources: {
    tr: { translation: tr },
    en: { translation: en },
  },
  lng: deviceLanguage(),
  fallbackLng: FALLBACK,
  interpolation: { escapeValue: false }, // React zaten XSS'e karsi kaciriyor
  returnNull: false,
});

// AsyncStorage async -> init'ten sonra oku; elle secim varsa cihaz dilini ez.
AsyncStorage.getItem(LANGUAGE_KEY)
  .then((saved) => {
    if (saved && SUPPORTED.includes(saved) && saved !== i18n.language) {
      i18n.changeLanguage(saved);
    }
  })
  .catch(() => {});

// Ayarlardan dil degistir: kalici yaz + i18next dilini aninda degistir (ekranlar re-render olur).
export async function setAppLanguage(lang) {
  if (!SUPPORTED.includes(lang)) return;
  try {
    await AsyncStorage.setItem(LANGUAGE_KEY, lang);
  } catch (e) {
    // kalici yazma basarisiz olsa bile dili yine de degistir
  }
  await i18n.changeLanguage(lang);
}

export default i18n;
