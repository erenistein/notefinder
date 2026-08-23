import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Alert, Animated, ActivityIndicator, Platform, Modal } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";
import {
  useAudioRecorder,
  RecordingPresets,
  IOSOutputFormat,
  AudioQuality,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from "expo-audio";
import { useTranslation } from "react-i18next";
import { useTheme } from "../theme/ThemeContext";
import { INSTRUMENTS, API } from "../constants";
import { saveJob, getJobs, jobToResultParams } from "../utils/storage";
import { startTranscribe, reconcileProcessingJobs } from "../services/jobs";
import { ensureNotifPermission } from "../services/notify";
import { formatRelativeDate } from "../utils/date";

// Kayit ayarlari. iOS -> GERCEK WAV (LINEARPCM). Android -> expo-audio WAV'i native
// DESTEKLEMIYOR, bu yuzden HIGH_QUALITY (m4a/AAC). Format kararini sonraki adimda netlestirecegiz.
const RECORDING_OPTIONS =
  Platform.OS === "ios"
    ? {
        ...RecordingPresets.HIGH_QUALITY,
        extension: ".wav",
        ios: {
          ...RecordingPresets.HIGH_QUALITY.ios,
          outputFormat: IOSOutputFormat.LINEARPCM,
          audioQuality: AudioQuality.MAX,
          linearPCMBitDepth: 16,
          linearPCMIsBigEndian: false,
          linearPCMIsFloat: false,
        },
      }
    : RecordingPresets.HIGH_QUALITY;

export default function HomeScreen({ navigation }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [url, setUrl] = useState("");
  const [selectedInstrument, setSelectedInstrument] = useState("piano");
  // Link akisi: kayitta ritim bolumu (davul/bas) var mi? -> demucs karari.
  // Varsayilan true (YouTube muziginin cogu produksiyonlu, davul/basli sarki).
  const [isFullSong, setIsFullSong] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [recordTime, setRecordTime] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState("");
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const timerRef = useRef(null);
  const recorder = useAudioRecorder(RECORDING_OPTIONS);
  const [nameModalVisible, setNameModalVisible] = useState(false);
  const [recordName, setRecordName] = useState("");
  const [pendingUri, setPendingUri] = useState(null);
  // "Son dönüştürmeler" artık tek kaynaktan (AsyncStorage) okunuyor - RAM history kaldırıldı.
  const [jobs, setJobs] = useState([]);

  const loadJobs = useCallback(async () => {
    // Bekleme ekranindan ayrilmis "processing" isleri backend'den senkronla, sonra listeyi tazele.
    await reconcileProcessingJobs().catch(() => {});
    setJobs(await getJobs());
  }, []);

  // Ana sayfaya her odaklanildiginda tazele (yeni dönüştürme dönünce güncel görünsün).
  useFocusEffect(
    useCallback(() => {
      loadJobs();
    }, [loadJobs])
  );

  useEffect(() => {
    if (isRecording) {
      Animated.loop(Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.15, duration: 700, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 700, useNativeDriver: true }),
      ])).start();
    } else { pulseAnim.setValue(1); }
  }, [isRecording]);

  // Otomatik kayit ismi (isim verilmezse / iptal edilirse)
  const autoRecordName = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${t("home.autoRecordPrefix")} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`;
  };

  // Ortak: job_id -> ASYNC transcribe baslat -> "processing" kaydi sakla -> Loading ekranina gec (poll orada).
  // Eski bloklayan /transcription/transcribe cagrisi yerine 202 donen /transcribe kullanilir.
  const transcribeAndOpen = async (jobId, title, useDemucs = true) => {
    const songTitle = title || t("home.unknownSong");
    ensureNotifPermission(); // iş biterken bildirim gönderebilmek için izni şimdi iste (fire-and-forget)
    const newJobId = await startTranscribe(jobId, selectedInstrument, useDemucs);
    // Notalarim'da hemen "İşleniyor..." gorunmesi icin processing kaydi (Loading ekrani done/failed'a gunceller).
    await saveJob({ jobId: newJobId, title: songTitle, instrument: selectedInstrument, status: "processing" });
    setLoading(false); // Home inline gostergesini kapat; bekleme ekrani devraliyor
    navigation.navigate("Loading", { jobId: newJobId, instrument: selectedInstrument, title: songTitle });
  };

  // Kaydı yükle (WAV, multipart 'file') + transcribe. Yükleme göstergesi açık, hata yönetimli.
  const processRecording = async (uri, name) => {
    setLoading(true);
    try {
      setLoadingStep(t("home.stepUploading"));
      const form = new FormData();
      form.append("file", { uri, name: "kayit.wav", type: "audio/wav" });
      const upRes = await fetch(`${API.BASE_URL}/api/v1/audio/upload`, { method: "POST", body: form });
      if (!upRes.ok) {
        const err = await upRes.json().catch(() => ({}));
        throw new Error(err.detail || t("home.uploadError"));
      }
      const upData = await upRes.json();
      // Mikrofon kaydı SOLO -> demucs atla (demucs solo sinyali zayıflatıyor: 27 nota -> 9).
      await transcribeAndOpen(upData.job_id, name, false);
      setLoading(false);
    } catch (e) {
      setLoading(false);
      console.warn("Kayıt işleme hatası:", e);
      // Backend'in anlamli mesajini goster (orn. "Kayıtta yeterli müzik algılanamadı...")
      Alert.alert(t("home.recordProcessFailTitle"), e?.message || t("home.recordProcessFailBody"));
    }
  };

  // Durdurulan kayda isim sor — iOS + Android ortak Modal. TextInput otomatik isimle ön-dolu.
  const openNameModal = (uri) => {
    setPendingUri(uri);
    setRecordName(autoRecordName());
    setNameModalVisible(true);
  };

  // "Kaydet": yazılan (boşsa otomatik) isimle işle.
  const confirmName = () => {
    const uri = pendingUri;
    const name = recordName.trim() || autoRecordName();
    setNameModalVisible(false);
    setPendingUri(null);
    setRecordName("");
    if (uri) processRecording(uri, name);
  };

  // "İptal": kaydı AT (işleme), modalı temizle.
  const cancelName = () => {
    setNameModalVisible(false);
    setPendingUri(null);
    setRecordName("");
  };

  const toggleRecord = async () => {
    if (isRecording) {
      // --- DURDUR ---
      clearInterval(timerRef.current);
      setIsRecording(false);
      setRecordTime(0);
      let uri = null;
      try {
        await recorder.stop();
        uri = recorder.uri;
      } catch (e) {
        console.warn("Kayıt durdurma hatası:", e);
      }
      if (uri) {
        openNameModal(uri); // isim modalını aç -> Kaydet: upload (WAV) -> transcribe -> Result
      } else {
        Alert.alert(t("common.error"), t("home.recordFileNotFound"));
      }
    } else {
      // --- BAŞLAT ---
      try {
        const perm = await requestRecordingPermissionsAsync();
        if (!perm.granted) {
          Alert.alert(t("home.micPermTitle"), t("home.micPermBody"));
          return;
        }
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        await recorder.prepareToRecordAsync();
        recorder.record();
        setIsRecording(true);
        timerRef.current = setInterval(() => setRecordTime((sec) => sec + 1), 1000);
      } catch (e) {
        console.warn("Kayıt başlatma hatası:", e);
        Alert.alert(t("common.error"), t("home.recordStartError", { error: e?.message || "" }));
      }
    }
  };

  const handleSubmitLink = async () => {
    if (!url.trim()) {
      Alert.alert(t("common.error"), t("home.errorEmptyLink"));
      return;
    }
    setLoading(true);
    try {
      // Adım 1: Ses indir
      setLoadingStep(t("home.stepDownloading"));
      const downloadRes = await fetch(`${API.BASE_URL}/api/v1/audio/from-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), instrument: selectedInstrument }),
      });
      if (!downloadRes.ok) {
        const err = await downloadRes.json();
        throw new Error(err.detail || t("home.downloadError"));
      }
      const downloadData = await downloadRes.json();

      // Adım 2: ASYNC transcribe başlat -> Loading ekranı (ilerleme orada poll edilir)
      await transcribeAndOpen(downloadData.job_id, downloadData.title, isFullSong);
    } catch (e) {
      setLoading(false);
      Alert.alert(t("common.error"), e.message);
    }
  };

  const formatTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  // Liste ogesine dokununca: processing -> bekleme ekranina don; failed -> uyari; done -> Result.
  const openJob = (item) => {
    if (item.status === "processing") {
      navigation.navigate("Loading", { jobId: item.jobId, instrument: item.instrument, title: item.title });
    } else if (item.status === "failed") {
      Alert.alert(t("loading.failedTitle"), t("home.failedRetryHint"));
    } else {
      navigation.navigate("Result", jobToResultParams(item));
    }
  };

  // Kayit sirasinda VE isim modali aciktayken enstruman degistirilemez (transcribe henuz olmadi).
  const instrumentsLocked = isRecording || nameModalVisible;

  if (loading) {
    return (
      <SafeAreaView style={s.container}>
        <View style={s.loadingBox}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={s.loadingText}>{loadingStep}</Text>
          <Text style={s.loadingHint}>{t("home.loadingHint")}</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.container}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={s.scroll}>
        <View style={s.header}>
          <TouchableOpacity style={s.settingsBtn} onPress={() => navigation.navigate("Settings")} activeOpacity={0.7} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={s.settingsIcon}>⚙️</Text>
          </TouchableOpacity>
          <Text style={s.brand}>NOTEFINDER</Text>
          <Text style={s.title}>{t("home.title")}</Text>
        </View>
        <View style={s.section}>
          <Text style={s.label}>{t("home.linkLabel")}</Text>
          <View style={s.inputRow}>
            <TextInput style={s.input} value={url} onChangeText={setUrl} placeholder="https://youtube.com/watch?v=..." placeholderTextColor={colors.textMuted} autoCapitalize="none" autoCorrect={false} />
            <TouchableOpacity style={[s.sendBtn, !url.trim() && { opacity: 0.5 }]} onPress={handleSubmitLink} disabled={!url.trim()}>
              <Text style={s.sendBtnText}>→</Text>
            </TouchableOpacity>
          </View>
          <Text style={[s.fullSongTitle, instrumentsLocked && { opacity: 0.4 }]}>{t("home.contentQuestion")}</Text>
          <View style={[s.fullSongRow, instrumentsLocked && { opacity: 0.4 }]}>
            <TouchableOpacity
              style={[s.fullSongBtn, isFullSong && s.fullSongBtnActive]}
              onPress={() => setIsFullSong(true)}
              disabled={instrumentsLocked}
              activeOpacity={0.7}
            >
              <Text style={[s.fullSongName, isFullSong && { color: colors.white }]}>{t("home.fullSong")}</Text>
              <Text style={[s.fullSongSub, isFullSong && { color: colors.white }]}>{t("home.fullSongSub")}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.fullSongBtn, !isFullSong && s.fullSongBtnActive]}
              onPress={() => setIsFullSong(false)}
              disabled={instrumentsLocked}
              activeOpacity={0.7}
            >
              <Text style={[s.fullSongName, !isFullSong && { color: colors.white }]}>{t("home.simpleRecording")}</Text>
              <Text style={[s.fullSongSub, !isFullSong && { color: colors.white }]}>{t("home.simpleRecordingSub")}</Text>
            </TouchableOpacity>
          </View>
          <Text style={s.fullSongHint}>{t("home.contentHint")}</Text>
        </View>
        <View style={s.divider}><View style={s.dividerLine} /><Text style={s.dividerText}>{t("home.orListen")}</Text><View style={s.dividerLine} /></View>
        <View style={s.micSection}>
          <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
            <TouchableOpacity style={[s.micButton, isRecording && s.micButtonRec]} onPress={toggleRecord} activeOpacity={0.7}>
              <Text style={s.micIcon}>{isRecording ? "⏹" : "🎤"}</Text>
            </TouchableOpacity>
          </Animated.View>
          <Text style={[s.micLabel, isRecording && { color: colors.danger, fontWeight: "700" }]}>{isRecording ? t("home.recording", { time: formatTime(recordTime) }) : t("home.listen")}</Text>
        </View>
        <View style={s.section}>
          <Text style={s.label}>{t("home.instrumentLabel")}</Text>
          <View style={[s.instRow, instrumentsLocked && { opacity: 0.4 }]}>
            {INSTRUMENTS.map((inst) => (
              <TouchableOpacity key={inst.id} style={[s.instBtn, selectedInstrument === inst.id && { backgroundColor: inst.color, borderColor: inst.color }]} onPress={() => setSelectedInstrument(inst.id)} disabled={instrumentsLocked} activeOpacity={0.7}>
                <Text style={s.instIcon}>{inst.icon}</Text>
                <Text style={[s.instName, selectedInstrument === inst.id && { color: colors.white }]}>{t(`instruments.${inst.id}`)}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={s.qualityHint}>{t("home.qualityHint")}</Text>
        </View>
        {jobs.length > 0 && (
          <View style={s.section}>
            <Text style={s.label}>{t("home.recentConversions")}</Text>
            {jobs.slice(0, 5).map((item) => {
              const inst = INSTRUMENTS.find((i) => i.id === item.instrument);
              return (
                <TouchableOpacity key={item.jobId} style={s.histItem} onPress={() => openJob(item)} activeOpacity={0.7}>
                  <Text style={s.histIcon}>{inst?.icon || "🎵"}</Text>
                  <View style={s.histInfo}>
                    <Text style={s.histTitle} numberOfLines={1}>{item.title}</Text>
                    <Text style={s.histMeta}>{inst ? t(`instruments.${inst.id}`) : item.instrument} · {formatRelativeDate(item.createdAt)}</Text>
                  </View>
                  {item.status === "processing" ? (
                    <Text style={s.histProcessing}>{t("history.processing")}</Text>
                  ) : item.status === "failed" ? (
                    <Text style={s.histFailed}>{t("history.failed")}</Text>
                  ) : (
                    <Text style={s.histArrow}>→</Text>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </ScrollView>

      <Modal visible={nameModalVisible} transparent animationType="fade" onRequestClose={cancelName}>
        <View style={s.modalOverlay}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>{t("home.nameModalTitle")}</Text>
            <Text style={s.modalSub}>{t("home.nameModalSub")}</Text>
            <TextInput
              style={s.modalInput}
              value={recordName}
              onChangeText={setRecordName}
              placeholder={t("home.nameModalPlaceholder")}
              placeholderTextColor={colors.textMuted}
              autoFocus
              selectTextOnFocus
            />
            <View style={s.modalRow}>
              <TouchableOpacity style={s.modalBtn} onPress={cancelName} activeOpacity={0.7}>
                <Text style={s.modalBtnText}>{t("common.cancel")}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.modalBtn, s.modalBtnPrimary]} onPress={confirmName} activeOpacity={0.8}>
                <Text style={s.modalBtnPrimaryText}>{t("common.save")}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const makeStyles = (c) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg }, scroll: { padding: 20, paddingBottom: 30 },
  header: { alignItems: "center", paddingVertical: 20 }, brand: { fontSize: 11, letterSpacing: 4, color: c.textSecondary, fontWeight: "600" },
  settingsBtn: { position: "absolute", right: 0, top: 16, padding: 6, zIndex: 1 }, settingsIcon: { fontSize: 22 },
  title: { fontSize: 24, fontWeight: "700", color: c.text, marginTop: 6 }, section: { marginBottom: 20 },
  label: { fontSize: 12, color: c.textSecondary, marginBottom: 8, fontWeight: "500" }, inputRow: { flexDirection: "row", gap: 8 },
  input: { flex: 1, height: 46, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, paddingHorizontal: 14, color: c.text, fontSize: 13 },
  sendBtn: { width: 46, height: 46, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: c.primary }, sendBtnText: { color: c.white, fontSize: 20, fontWeight: "700" },
  divider: { flexDirection: "row", alignItems: "center", gap: 10, marginVertical: 10 }, dividerLine: { flex: 1, height: 1, backgroundColor: c.border }, dividerText: { fontSize: 11, color: c.textMuted },
  micSection: { alignItems: "center", marginVertical: 16 }, micButton: { width: 100, height: 100, borderRadius: 50, borderWidth: 3, borderColor: c.danger, alignItems: "center", justifyContent: "center" },
  micButtonRec: { backgroundColor: c.danger + "26", borderColor: c.danger }, micIcon: { fontSize: 40 }, micLabel: { fontSize: 13, color: c.textSecondary, marginTop: 10 },
  fullSongTitle: { fontSize: 12, color: c.textSecondary, marginTop: 14, marginBottom: 8, fontWeight: "500" },
  fullSongRow: { flexDirection: "row", gap: 8 },
  fullSongBtn: { flex: 1, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, alignItems: "center" },
  fullSongBtnActive: { backgroundColor: c.primary, borderColor: c.primary },
  fullSongName: { fontSize: 13, fontWeight: "700", color: c.text },
  fullSongSub: { fontSize: 11, fontWeight: "500", color: c.textSecondary, marginTop: 2 },
  fullSongHint: { fontSize: 11, color: c.textMuted, marginTop: 6 },
  instRow: { flexDirection: "row", gap: 8 }, instBtn: { flex: 1, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, alignItems: "center" },
  instIcon: { fontSize: 22, marginBottom: 4 }, instName: { fontSize: 11, fontWeight: "600", color: c.textSecondary },
  qualityHint: { fontSize: 11, color: c.textMuted, lineHeight: 15, marginTop: 10 },
  histItem: { flexDirection: "row", alignItems: "center", padding: 14, borderRadius: 12, backgroundColor: c.surface, marginBottom: 8, gap: 12 },
  histIcon: { fontSize: 26 }, histInfo: { flex: 1 }, histTitle: { fontSize: 14, fontWeight: "600", color: c.text }, histMeta: { fontSize: 11, color: c.textSecondary, marginTop: 2 }, histArrow: { fontSize: 16, color: c.textMuted },
  histProcessing: { fontSize: 11, fontWeight: "700", color: c.primary }, histFailed: { fontSize: 11, fontWeight: "700", color: c.danger },
  loadingBox: { flex: 1, alignItems: "center", justifyContent: "center", padding: 30 },
  loadingText: { fontSize: 16, fontWeight: "600", color: c.text, marginTop: 20 },
  loadingHint: { fontSize: 13, color: c.textSecondary, marginTop: 8 },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", alignItems: "center", justifyContent: "center", padding: 24 },
  modalCard: { width: "100%", maxWidth: 380, backgroundColor: c.surface, borderRadius: 16, borderWidth: 1, borderColor: c.border, padding: 20 },
  modalTitle: { fontSize: 17, fontWeight: "700", color: c.text },
  modalSub: { fontSize: 12, color: c.textSecondary, marginTop: 4, marginBottom: 14 },
  modalInput: { height: 46, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.bg, paddingHorizontal: 14, color: c.text, fontSize: 14 },
  modalRow: { flexDirection: "row", gap: 10, marginTop: 18 },
  modalBtn: { flex: 1, paddingVertical: 13, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceLight, alignItems: "center" },
  modalBtnText: { color: c.text, fontSize: 14, fontWeight: "600" },
  modalBtnPrimary: { backgroundColor: c.primary, borderColor: c.primary },
  modalBtnPrimaryText: { color: c.white, fontSize: 14, fontWeight: "700" },
});
