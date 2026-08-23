import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { View, Text, StyleSheet, Animated, Easing, AppState, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useTheme } from "../theme/ThemeContext";
import { getJob } from "../services/jobs";
import { notifyReady } from "../services/notify";
import { saveJob } from "../utils/storage";

const POLL_MS = 5000;

// Ilerleme yuzdesinden yerellestirilmis asama etiketi (backend mesaji Turkce; i18n icin buradan turetiyoruz).
function stageKey(progress) {
  if (progress >= 100) return "loading.stageDone";
  if (progress >= 86) return "loading.stageRendering";
  if (progress >= 12) return "loading.stageAnalyzing";
  return "loading.stageQueued";
}

// Gercek bekleme ekrani: verilen jobId'i 5 sn'de bir sorgular, ilerleme cubugunu gunceller.
// done -> kaydi sakla + Result'a gec; failed -> Turkce hata + geri. AppState 'active' olunca beklemeden sorgular.
export default function LoadingScreen({ navigation, route }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const { jobId, instrument = "piano", title = "" } = route.params || {};

  const [progress, setProgress] = useState(0);
  const spinAnim = useRef(new Animated.Value(0)).current;
  const barAnim = useRef(new Animated.Value(0)).current;

  const doneRef = useRef(false); // terminal (done/failed) islemi YALNIZ bir kez
  const timerRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    Animated.loop(
      Animated.timing(spinAnim, { toValue: 1, duration: 2000, easing: Easing.linear, useNativeDriver: true })
    ).start();
  }, []);

  useEffect(() => {
    Animated.timing(barAnim, { toValue: progress, duration: 400, easing: Easing.out(Easing.quad), useNativeDriver: false }).start();
  }, [progress]);

  const safeTitle = title || t("home.unknownSong");

  const handleDone = useCallback(async (job) => {
    if (doneRef.current) return;
    doneRef.current = true;
    const r = job.result || {};
    await saveJob({
      jobId, title: safeTitle, instrument,
      tempo: r.tempo, key: r.key, totalNotes: r.total_notes,
      duration: r.duration_seconds, hasPdf: !!r.pdf_file, status: "done",
    });
    // "Notaların hazır" yerel bildirimi (arka planda kalindiysa da haber olsun). Fire-and-forget.
    notifyReady(t("notif.readyTitle"), t("notif.readyBody", { title: safeTitle }));
    navigation.replace("Result", {
      instrument, title: safeTitle, jobId,
      tempo: r.tempo, key: r.key, totalNotes: r.total_notes, duration: r.duration_seconds,
      pdfFile: r.pdf_file, midiFile: r.midi_file, notes: r.notes || [],
    });
  }, [jobId, instrument, safeTitle, navigation, t]);

  const handleFailed = useCallback(async (job) => {
    if (doneRef.current) return;
    doneRef.current = true;
    await saveJob({ jobId, title: safeTitle, instrument, status: "failed" });
    Alert.alert(t("loading.failedTitle"), (job && job.error) || t("loading.failedBody"), [
      { text: t("common.ok"), onPress: () => navigation.goBack() },
    ]);
  }, [jobId, instrument, safeTitle, navigation, t]);

  // Tek sorgu; terminal degilse sonraki poll'u planla.
  const tick = useCallback(async () => {
    if (doneRef.current || !mountedRef.current) return;
    const job = await getJob(jobId);
    if (!mountedRef.current || doneRef.current) return;
    if (job) {
      if (typeof job.progress === "number") setProgress(job.progress);
      if (job.status === "done") { handleDone(job); return; }
      if (job.status === "failed") { handleFailed(job); return; }
    }
    timerRef.current = setTimeout(tick, POLL_MS);
  }, [jobId, handleDone, handleFailed]);

  useEffect(() => {
    mountedRef.current = true;
    if (!jobId) { handleFailed({ error: t("loading.failedBody") }); return undefined; }
    tick(); // ilk sorgu hemen
    // Uygulama on plana donunce beklemeden hemen sorgula (arka planda timer'lar kisitlanabilir).
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && !doneRef.current) {
        if (timerRef.current) clearTimeout(timerRef.current);
        tick();
      }
    });
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      sub.remove();
    };
  }, [jobId, tick, handleFailed, t]);

  const spin = spinAnim.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  const barWidth = barAnim.interpolate({ inputRange: [0, 100], outputRange: ["0%", "100%"], extrapolate: "clamp" });

  return (
    <SafeAreaView style={s.container}>
      <View style={s.content}>
        <Animated.Text style={[s.spinIcon, { transform: [{ rotate: spin }] }]}>🎵</Animated.Text>
        <Text style={s.title}>{t("loading.title")}</Text>
        <Text style={s.subtitle}>{t("loading.subtitle")}</Text>
        <View style={s.barBg}><Animated.View style={[s.barFill, { width: barWidth }]} /></View>
        <Text style={s.pctText}>{Math.round(progress)}%</Text>
        <Text style={s.stage}>{t(stageKey(progress))}</Text>
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (c) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  content: { flex: 1, padding: 30, alignItems: "center", justifyContent: "center" },
  spinIcon: { fontSize: 60, marginBottom: 24 },
  title: { fontSize: 20, fontWeight: "700", color: c.text, marginBottom: 6 },
  subtitle: { fontSize: 13, color: c.textSecondary, marginBottom: 30, textAlign: "center" },
  barBg: { width: "100%", height: 6, borderRadius: 3, backgroundColor: c.border, overflow: "hidden", marginBottom: 8 },
  barFill: { height: "100%", borderRadius: 3, backgroundColor: c.primary },
  pctText: { fontSize: 12, color: c.textSecondary, marginBottom: 14 },
  stage: { fontSize: 14, fontWeight: "600", color: c.text },
});
