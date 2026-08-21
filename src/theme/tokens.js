// Tema token setleri. Anahtar isimleri iki sette BIREBIR AYNI olmali.
// darkTokens = mevcut COLORS degerleri (hicbir renk degismedi).
// lightTokens = ayni anahtarlarin acik karsiliklari.

export const darkTokens = {
  bg: "#0d0d0d",
  surface: "#1a1a1a",
  surfaceLight: "#222222",
  border: "#2a2a2a",
  text: "#f0f0f0",
  textSecondary: "#888888",
  textMuted: "#555555",
  primary: "#534AB7",
  primaryLight: "#6B63C7",
  success: "#1D9E75",
  danger: "#D85A30",
  info: "#378ADD",
  white: "#ffffff",
};

export const lightTokens = {
  bg: "#f7f7f9",          // istenen: en acik notr zemin
  surface: "#ffffff",     // istenen: kartlar (zemin uzerinde beyaz, yukseltilmis)
  surfaceLight: "#ececf1", // ONERI: ikincil/basili yuzey (beyaz kart ile bg arasi hafif gri)
  border: "#e3e3e8",      // istenen: acik gri ayirici
  text: "#141414",        // istenen: birincil metin
  textSecondary: "#6b6b76", // istenen: ikincil metin
  textMuted: "#a1a1ac",   // ONERI: en soluk metin katmani (textSecondary'den daha acik)
  primary: "#534AB7",     // istenen: sabit (iki temada ayni marka moru)
  primaryLight: "#6B63C7", // ONERI: primary'nin acik tonu; beyaz uzerinde aksan olarak calisir (sabit tuttum)
  success: "#1D9E75",     // istenen: dark ile ayni
  danger: "#D85A30",      // istenen: dark ile ayni (error)
  info: "#378ADD",        // istenen: dark ile ayni (warning/info)
  white: "#ffffff",       // sabit: renkli yuzeyler uzerindeki kontrast/ters metin (iki temada da beyaz)
};

// Geriye uyumluluk guvenlik agi: ekranlar artik useTheme kullaniyor, bu export
// hicbir yerde import edilmiyor; ileride ihtiyac olursa diye dark'a esit tutuluyor.
export const COLORS = darkTokens;
