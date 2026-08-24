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
import * as ImagePicker from "expo-image-picker";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import { File as FSFile } from "expo-file-system";
import { useTranslation } from "react-i18next";
import { useTheme } from "../theme/ThemeContext";
import { INSTRUMENTS, API } from "../constants";
import { saveJob, getJobs, jobToResultParams } from "../utils/storage";
import { startTranscribe, startOmr, getJob, reconcileProcessingJobs } from "../services/jobs";
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
  // Enstruman SECIMSIZ baslar (null) -> "hicbir sey secmezse hepsi gozuksun". Donusum icin secim ZORUNLU.
  const [selectedInstrument, setSelectedInstrument] = useState(null);
  // Link akisi: kayitta ritim bolumu (davul/bas) var mi? -> demucs karari.
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
  const [jobs, setJobs] = useState([]);

  const loadJobs = useCallback(async () => {
    // Bekleme ekranindan ayrilmis "processing" isleri backend'den senkronla, sonra listeyi tazele.
    await reconcileProcessingJobs().catch(() => {});
    setJobs(await getJobs());
  }, []);

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

  const autoRecordName = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${t("home.autoRecordPrefix")} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`;
  };

  // Donusum baslatmadan once enstruman secili mi? Degilse uyar ve akisi durdur.
  const requireInstrument = () => {
    if (!selectedInstrument) {
      Alert.alert(t("home.selectInstrumentTitle"), t("home.selectInstrumentBody"));
      return false;
    }
    return true;
  };

  // Tek aktif is sinirlamasi: sürüyor bir job varsa yeni donusum baslatilamaz (frontend-only).
  // Doner: true = engellendi (uyari gosterildi). false = devam edilebilir.
  const checkActiveJob = async () => {
    const list = await getJobs();
    const active = list.find((j) => j.status === "processing");
    if (!active) return false;
    // storage bayat olabilir -> gercekten suruyor mu backend'den dogrula
    const job = await getJob(active.jobId);
    if (job && (job.status === "done" || job.status === "failed")) {
      await reconcileProcessingJobs().catch(() => {});
      return false; // aslinda bitmis -> engelleme yok
    }
    Alert.alert(t("home.activeJobTitle"), t("home.activeJobBody"), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("home.goToActive"), onPress: () => navigation.navigate("Loading", { jobId: active.jobId, instrument: active.instrument, title: active.title }) },
    ]);
    return true; // engellendi
  };

  // Ortak: job_id -> ASYNC transcribe baslat -> "processing" kaydi sakla -> Loading ekranina gec.
  const transcribeAndOpen = async (jobId, title, useDemucs = true) => {
    const songTitle = title || t("home.unknownSong");
    ensureNotifPermission();
    const newJobId = await startTranscribe(jobId, selectedInstrument, useDemucs);
    await saveJob({ jobId: newJobId, title: songTitle, instrument: selectedInstrument, status: "processing" });
    setLoading(false);
    navigation.navigate("Loading", { jobId: newJobId, instrument: selectedInstrument, title: songTitle });
  };

  // Kaydi yukle (WAV) + transcribe.
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
      // Mikrofon kaydi SOLO -> demucs atla.
      await transcribeAndOpen(upData.job_id, name, false);
      setLoading(false);
    } catch (e) {
      setLoading(false);
      console.warn("Kayit isleme hatasi:", e);
      Alert.alert(t("home.recordProcessFailTitle"), e?.message || t("home.recordProcessFailBody"));
    }
  };

  // OMR: kamera/galeriden nota fotografi -> upload -> startOmr -> Loading ekrani (poll orada).
  const pickPhoto = async (fromCamera) => {
    if (!requireInstrument()) return;
    if (await checkActiveJob()) return;
    // iOS'ta allowsEditing KARE (1:1) kirpma dayatip dikey nota sayfasini kesiyordu (480x640 -> 383x384 kare,
    // staves'in ~%75'i + cozunurluk kaybi). iOS'ta KAPALI (kirpmayi kullanici galeride yapsin); Android'de
    // serbest-oran kirpici oldugu icin acik. exif/base64/coklu-secim gereksiz -> kapali.
    const opts = {
      allowsEditing: Platform.OS === "android",
      allowsMultipleSelection: false,
      exif: false,
      base64: false,
      quality: 1,
    };
    try {
      let perm, result;
      if (fromCamera) {
        perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) { Alert.alert(t("home.cameraPermTitle"), t("home.cameraPermBody")); return; }
        result = await ImagePicker.launchCameraAsync(opts);
      } else {
        perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) { Alert.alert(t("home.galleryPermTitle"), t("home.galleryPermBody")); return; }
        result = await ImagePicker.launchImageLibraryAsync(opts);
      }
      if (result.canceled) return;
      const asset = result.assets && result.assets[0];
      if (!asset || !asset.uri) return;

      // iOS: kirpma yok -> sadece notayi cerceveleme hatirlatmasi (onaylamazsa vazgec)
      if (Platform.OS === "ios") {
        const ok = await new Promise((resolve) => {
          Alert.alert(t("home.photoCropReminderTitle"), t("home.photoCropReminderBody"), [
            { text: t("common.cancel"), style: "cancel", onPress: () => resolve(false) },
            { text: t("common.ok"), onPress: () => resolve(true) },
          ], { cancelable: false });
        });
        if (!ok) return;
      }

      // Dusuk cozunurluk UYARISI (engellemez -> onaylayinca devam eder)
      if (asset.width && asset.width < 700) {
        await new Promise((resolve) => {
          Alert.alert(t("home.lowResTitle"), t("home.lowResBody"), [
            { text: t("common.ok"), onPress: () => resolve() },
          ], { cancelable: false });
        });
      }

      await processPhoto(asset);
    } catch (e) {
      console.warn("Foto secme hatasi:", e);
      Alert.alert(t("common.error"), e?.message || "");
    }
  };

  // Upload ONCESI kucultme/format: uzun kenar > 2400 -> 2400'e olcekle (orani koru); her durumda
  // JPEG %85 (HEIC gelirse de JPEG olur). Upload suresini + backend yukunu dusurur. Isleme hata
  // verirse orijinali kullanir (engellemez). Doner: kullanilacak uri.
  const prepareImage = async (asset) => {
    const w = asset.width || 0, h = asset.height || 0;
    const actions = [];
    if (Math.max(w, h) > 2400) {
      actions.push(w >= h ? { resize: { width: 2400 } } : { resize: { height: 2400 } });
    }
    try {
      const out = await manipulateAsync(asset.uri, actions, { compress: 0.85, format: SaveFormat.JPEG });
      return out.uri;
    } catch (e) {
      console.warn("Goruntu on-isleme atlandi:", e);
      return asset.uri;
    }
  };

  const processPhoto = async (asset) => {
    setLoading(true);
    try {
      setLoadingStep(t("home.stepUploadingPhoto"));
      const uri = await prepareImage(asset);
      // Yuklenecek dosya boyutunu goster
      let sizeMB = null;
      try { const sz = new FSFile(uri).size; if (sz) sizeMB = (sz / 1048576).toFixed(1); } catch (e) { /* boyut alinamadi */ }
      setLoadingStep(sizeMB ? t("home.stepUploadingPhotoSize", { size: sizeMB }) : t("home.stepUploadingPhoto"));

      const form = new FormData();
      form.append("file", { uri, name: "nota.jpg", type: "image/jpeg" });

      // 120 sn timeout (AbortController) -> yavas Wi-Fi'da sonsuza kadar takilmasin
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000);
      let upRes;
      try {
        upRes = await fetch(`${API.BASE_URL}/api/v1/audio/upload`, { method: "POST", body: form, signal: controller.signal });
      } catch (e) {
        if (e && e.name === "AbortError") throw new Error(t("home.uploadTimeout"));
        throw e;
      } finally {
        clearTimeout(timeoutId);
      }
      if (!upRes.ok) {
        const err = await upRes.json().catch(() => ({}));
        throw new Error(err.detail || t("home.uploadError"));
      }
      const upData = await upRes.json();
      ensureNotifPermission();
      const newJobId = await startOmr(upData.job_id, selectedInstrument);
      const title = t("home.photoJobTitle");
      await saveJob({ jobId: newJobId, title, instrument: selectedInstrument, status: "processing" });
      setLoading(false);
      navigation.navigate("Loading", { jobId: newJobId, instrument: selectedInstrument, title });
    } catch (e) {
      setLoading(false);
      console.warn("Foto isleme hatasi:", e);
      Alert.alert(t("common.error"), e?.message || t("home.uploadError"));
    }
  };

  const openNameModal = (uri) => {
    setPendingUri(uri);
    setRecordName(autoRecordName());
    setNameModalVisible(true);
  };

  const confirmName = () => {
    const uri = pendingUri;
    const name = recordName.trim() || autoRecordName();
    setNameModalVisible(false);
    setPendingUri(null);
    setRecordName("");
    if (uri) processRecording(uri, name);
  };

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
        console.warn("Kayit durdurma hatasi:", e);
      }
      if (uri) {
        openNameModal(uri);
      } else {
        Alert.alert(t("common.error"), t("home.recordFileNotFound"));
      }
    } else {
      // --- BASLAT ---
      if (!requireInstrument()) return;
      if (await checkActiveJob()) return;
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
        console.warn("Kayit baslatma hatasi:", e);
        Alert.alert(t("common.error"), t("home.recordStartError", { error: e?.message || "" }));
      }
    }
  };

  const handleSubmitLink = async () => {
    if (!url.trim()) {
      Alert.alert(t("common.error"), t("home.errorEmptyLink"));
      return;
    }
    if (!requireInstrument()) return;
    if (await checkActiveJob()) return;
    setLoading(true);
    try {
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
      await transcribeAndOpen(downloadData.job_id, downloadData.title, isFullSong);
    } catch (e) {
      setLoading(false);
      Alert.alert(t("common.error"), e.message);
    }
  };

  const formatTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  const openJob = (item) => {
    if (item.status === "processing") {
      navigation.navigate("Loading", { jobId: item.jobId, instrument: item.instrument, title: item.title });
    } else if (item.status === "failed") {
      Alert.alert(t("loading.failedTitle"), t("home.failedRetryHint"));
    } else {
      navigation.navigate("Result", jobToResultParams(item));
    }
  };

  // Enstruman degistirilemez durum (kayit/isim modali aktifken)
  const instrumentsLocked = isRecording || nameModalVisible;
  // Enstruman secilmedikce donusum butonlari dim (uyari yine de basinca cikar)
  const flowDim = !selectedInstrument;
  // "Son donusturmeler" enstrumana gore filtrele (secim yoksa hepsi)
  const filteredJobs = selectedInstrument ? jobs.filter((j) => j.instrument === selectedInstrument) : jobs;

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

        {/* Enstruman secici — iki akisin DISINDA, tek yerde (ustte) */}
        <View style={s.selectorBlock}>
          <Text style={s.sectionTitle}>{t("home.instrumentSection")}</Text>
          <View style={[s.instRow, instrumentsLocked && { opacity: 0.4 }]}>
            {INSTRUMENTS.map((inst) => {
              const active = selectedInstrument === inst.id;
              return (
                <TouchableOpacity key={inst.id} style={[s.instBtn, active && { backgroundColor: inst.color, borderColor: inst.color }]} onPress={() => setSelectedInstrument(inst.id)} disabled={instrumentsLocked} activeOpacity={0.8}>
                  <Text style={s.instIcon}>{inst.icon}</Text>
                  <Text style={[s.instName, active && { color: colors.white }]}>{t(`instruments.${inst.id}`)}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* KART 1: Sesten nota (link + tam/sade + mikrofon) */}
        <View style={s.card}>
          <Text style={s.cardTitle}>🎧 {t("home.audioCardTitle")}</Text>
          <Text style={s.label}>{t("home.linkLabel")}</Text>
          <View style={s.inputRow}>
            <TextInput style={s.input} value={url} onChangeText={setUrl} placeholder="https://youtube.com/watch?v=..." placeholderTextColor={colors.textMuted} autoCapitalize="none" autoCorrect={false} />
            <TouchableOpacity style={[s.sendBtn, (!url.trim() || flowDim) && { opacity: 0.5 }]} onPress={handleSubmitLink} disabled={!url.trim()} activeOpacity={0.8}>
              <Text style={s.sendBtnText}>→</Text>
            </TouchableOpacity>
          </View>
          <Text style={[s.fullSongTitle, instrumentsLocked && { opacity: 0.4 }]}>{t("home.contentQuestion")}</Text>
          <View style={[s.fullSongRow, instrumentsLocked && { opacity: 0.4 }]}>
            <TouchableOpacity style={[s.fullSongBtn, isFullSong && s.fullSongBtnActive]} onPress={() => setIsFullSong(true)} disabled={instrumentsLocked} activeOpacity={0.8}>
              <Text style={[s.fullSongName, isFullSong && { color: colors.white }]}>{t("home.fullSong")}</Text>
              <Text style={[s.fullSongSub, isFullSong && { color: colors.white }]}>{t("home.fullSongSub")}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.fullSongBtn, !isFullSong && s.fullSongBtnActive]} onPress={() => setIsFullSong(false)} disabled={instrumentsLocked} activeOpacity={0.8}>
              <Text style={[s.fullSongName, !isFullSong && { color: colors.white }]}>{t("home.simpleRecording")}</Text>
              <Text style={[s.fullSongSub, !isFullSong && { color: colors.white }]}>{t("home.simpleRecordingSub")}</Text>
            </TouchableOpacity>
          </View>
          <View style={s.divider}><View style={s.dividerLine} /><Text style={s.dividerText}>{t("home.orListen")}</Text><View style={s.dividerLine} /></View>
          <View style={s.micSection}>
            <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
              <TouchableOpacity style={[s.micButton, isRecording && s.micButtonRec, flowDim && !isRecording && { opacity: 0.5 }]} onPress={toggleRecord} activeOpacity={0.8}>
                <Text style={s.micIcon}>{isRecording ? "⏹" : "🎤"}</Text>
              </TouchableOpacity>
            </Animated.View>
            <Text style={[s.micLabel, isRecording && { color: colors.danger, fontWeight: "700" }]}>{isRecording ? t("home.recording", { time: formatTime(recordTime) }) : t("home.listen")}</Text>
          </View>
        </View>
        <Text style={s.cardHint}>{t("home.qualityHint")}</Text>

        {/* KART 2: Nota fotografindan (OMR) */}
        <View style={s.card}>
          <Text style={s.cardTitle}>📷 {t("home.photoCardTitle")}</Text>
          <View style={s.photoRow}>
            <TouchableOpacity style={[s.photoBtn, flowDim && { opacity: 0.5 }]} onPress={() => pickPhoto(true)} activeOpacity={0.8}>
              <Text style={s.photoBtnIcon}>📷</Text>
              <Text style={s.photoBtnLabel}>{t("home.photoTake")}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.photoBtn, flowDim && { opacity: 0.5 }]} onPress={() => pickPhoto(false)} activeOpacity={0.8}>
              <Text style={s.photoBtnIcon}>🖼️</Text>
              <Text style={s.photoBtnLabel}>{t("home.photoPick")}</Text>
            </TouchableOpacity>
          </View>
        </View>
        <Text style={s.cardHint}>{t("home.photoHint")}</Text>

        {/* Son donusturmeler — enstrumana gore filtreli */}
        {jobs.length > 0 && (
          <View style={s.recentBlock}>
            <Text style={s.sectionTitle}>
              {t("home.recentConversions")}{selectedInstrument ? ` · ${t(`instruments.${selectedInstrument}`)}` : ""}
            </Text>
            {filteredJobs.length === 0 ? (
              <Text style={s.emptyFilterText}>{t("home.noConversionsForInstrument")}</Text>
            ) : (
              filteredJobs.slice(0, 5).map((item) => {
                const inst = INSTRUMENTS.find((i) => i.id === item.instrument);
                return (
                  <TouchableOpacity key={item.jobId} style={s.histItem} onPress={() => openJob(item)} activeOpacity={0.8}>
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
              })
            )}
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
  title: { fontSize: 24, fontWeight: "700", color: c.text, marginTop: 6 },

  // Bolum basligi: kucuk caps, ikincil metin
  sectionTitle: { fontSize: 11, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase", color: c.textSecondary, marginBottom: 10 },
  selectorBlock: { marginBottom: 24 },
  recentBlock: { marginTop: 8 },

  // Kart: yuzey + kenarlik + hafif golge (iki temada da; dark'ta kenarlik, light'ta golge tanimlar)
  card: {
    backgroundColor: c.surface, borderRadius: 16, borderWidth: 1, borderColor: c.border, padding: 16, marginBottom: 8,
    shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2,
  },
  cardTitle: { fontSize: 15, fontWeight: "700", color: c.text, marginBottom: 14 },
  cardHint: { fontSize: 11, color: c.textMuted, lineHeight: 16, marginBottom: 24, paddingHorizontal: 2 },

  label: { fontSize: 12, color: c.textSecondary, marginBottom: 8, fontWeight: "500" },
  inputRow: { flexDirection: "row", gap: 8 },
  input: { flex: 1, height: 46, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.bg, paddingHorizontal: 14, color: c.text, fontSize: 13 },
  sendBtn: { width: 46, height: 46, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: c.primary }, sendBtnText: { color: c.white, fontSize: 20, fontWeight: "700" },

  divider: { flexDirection: "row", alignItems: "center", gap: 10, marginVertical: 16 }, dividerLine: { flex: 1, height: 1, backgroundColor: c.border }, dividerText: { fontSize: 11, color: c.textMuted },
  micSection: { alignItems: "center", marginTop: 4 }, micButton: { width: 96, height: 96, borderRadius: 48, borderWidth: 3, borderColor: c.danger, alignItems: "center", justifyContent: "center", backgroundColor: c.bg },
  micButtonRec: { backgroundColor: c.danger + "26", borderColor: c.danger }, micIcon: { fontSize: 38 }, micLabel: { fontSize: 13, color: c.textSecondary, marginTop: 10 },

  fullSongTitle: { fontSize: 12, color: c.textSecondary, marginTop: 16, marginBottom: 8, fontWeight: "500" },
  fullSongRow: { flexDirection: "row", gap: 8 },
  fullSongBtn: { flex: 1, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.bg, alignItems: "center" },
  fullSongBtnActive: { backgroundColor: c.primary, borderColor: c.primary },
  fullSongName: { fontSize: 13, fontWeight: "700", color: c.text },
  fullSongSub: { fontSize: 11, fontWeight: "500", color: c.textSecondary, marginTop: 2 },

  // Foto kart butonlari
  photoRow: { flexDirection: "row", gap: 10 },
  photoBtn: { flex: 1, paddingVertical: 18, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.bg, alignItems: "center", gap: 6 },
  photoBtnIcon: { fontSize: 26 }, photoBtnLabel: { fontSize: 12, fontWeight: "600", color: c.text },

  instRow: { flexDirection: "row", gap: 8 }, instBtn: { flex: 1, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, alignItems: "center" },
  instIcon: { fontSize: 22, marginBottom: 4 }, instName: { fontSize: 11, fontWeight: "600", color: c.textSecondary },

  emptyFilterText: { fontSize: 12, color: c.textMuted, paddingVertical: 10 },
  histItem: { flexDirection: "row", alignItems: "center", padding: 14, borderRadius: 12, backgroundColor: c.surface, marginBottom: 8, gap: 12, borderWidth: 1, borderColor: c.border },
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
