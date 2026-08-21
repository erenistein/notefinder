// Renkler artik theme/tokens + useTheme uzerinden geliyor. COLORS re-export'u kaldirildi
// (hicbir ekran artik import etmiyor). INSTRUMENTS'taki renkler enstruman-marka verisidir.
export const INSTRUMENTS = [
  { id: "piano", name: "Piyano", icon: "🎹", color: "#534AB7" },
  { id: "guitar", name: "Gitar", icon: "🎸", color: "#D85A30" },
  { id: "saz", name: "Saz", icon: "🪕", color: "#1D9E75" },
  { id: "violin", name: "Keman", icon: "🎻", color: "#378ADD" },
  { id: "ud", name: "Ud", icon: "🪕", color: "#B8893A" },
];

export const API = {
  // TEK KAYNAK — backend adresi. Web (npx expo start -> w) icin localhost calisir.
  // GERCEK CIHAZ (telefon) testi icin gelistirme PC'sinin LAN IP'siyle degistir:
  //   BASE_URL: "http://192.168.1.X:8000"   (telefon ve PC ayni Wi-Fi'da olmali)
  BASE_URL: "http://192.168.1.XXX:8000",
  ENDPOINTS: {
    HEALTH: "/health",
    FROM_LINK: "/api/v1/audio/from-link",
    UPLOAD: "/api/v1/audio/upload",
    STATUS: "/api/v1/audio/status",
    TRANSCRIBE: "/api/v1/transcription/transcribe",
    CONVERT: "/api/v1/transcription/convert",
    DOWNLOAD_PDF: "/api/v1/download", // kullanim: `${BASE_URL}/api/v1/download/${jobId}/pdf`
  },
};