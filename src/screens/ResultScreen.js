import React, { useState, useMemo } from "react";
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Alert, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useTheme } from "../theme/ThemeContext";
import { INSTRUMENTS, API } from "../constants";
import { downloadAndShare } from "../utils/share";

export default function ResultScreen({ navigation, route }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const songTitle = route.params?.title || t("result.newSong");
  const currentInstrument = route.params?.instrument || "piano";
  // Indirme/gosterim job'i. (Convert kaldirildi -> kaynak job ile ayni kalir.)
  const currentJobId = route.params?.jobId || "";
  const tempo = route.params?.tempo || 0;
  const keyName = route.params?.key || "";
  const duration = route.params?.duration || 0;
  const totalNotes = route.params?.totalNotes || 0;
  const notes = route.params?.notes || [];
  const hasPdf = !!route.params?.pdfFile;
  // OMR uyarlama: undefined=ses akisi (gizle); null=kaynak==hedef (oldugu gibi); str=kaynak enstruman
  const convertedFrom = route.params?.convertedFrom;
  const [downloading, setDownloading] = useState(false);

  const inst = INSTRUMENTS.find((i) => i.id === currentInstrument);
  const instName = (id) => {
    const x = INSTRUMENTS.find((i) => i.id === id);
    return x ? t(`instruments.${x.id}`) : id;
  };

  const formatDuration = (sec) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  // Indir + paylas (cache'e indir, sonra native paylas menusu). Cift basmayi engeller.
  const runShare = async (url, fname) => {
    if (downloading) return;
    setDownloading(true);
    try {
      await downloadAndShare(url, fname);
    } finally {
      setDownloading(false);
    }
  };

  const handleDownloadPDF = () => {
    if (!hasPdf) {
      Alert.alert(t("common.error"), t("result.pdfNotReady"));
      return;
    }
    runShare(`${API.BASE_URL}/api/v1/download/${currentJobId}/pdf`, `NoteFindr_${currentJobId}.pdf`);
  };

  const handleDownloadMIDI = () => {
    runShare(`${API.BASE_URL}/api/v1/download/${currentJobId}/midi`, `NoteFindr_${currentJobId}.mid`);
  };

  // Paylas butonu: en mantiklisi PDF; PDF yoksa MIDI'ye duser.
  const handleShare = () => (hasPdf ? handleDownloadPDF() : handleDownloadMIDI());

  return (
    <SafeAreaView style={s.container}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={s.scroll}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={s.backBtn}><Text style={s.backText}>←</Text></TouchableOpacity>
          <View style={s.headerCenter}><Text style={s.headerTitle}>{songTitle}</Text><Text style={s.headerSub}>{inst?.icon} {inst ? t(`instruments.${inst.id}`) : currentInstrument} · {keyName}</Text></View>
          <View style={{ width: 40 }} />
        </View>

        {convertedFrom !== undefined && (
          <View style={s.adaptRow}>
            <Text style={s.adaptText}>
              {convertedFrom
                ? `🎚️ ${t("result.adaptedInfo", { source: instName(convertedFrom), target: instName(currentInstrument) })}`
                : `✓ ${t("result.asIsInfo")}`}
            </Text>
          </View>
        )}

        <View style={[s.sheet, { borderColor: inst?.color + "40" }]}>
          <View style={s.notesList}>
            <Text style={[s.notesTitle, { color: inst?.color }]}>{t("result.first20Notes")}</Text>
            {notes.slice(0, 20).map((n, i) => (
              <View key={i} style={s.noteRow}>
                <Text style={[s.noteLabel, { backgroundColor: inst?.color + "20", color: inst?.color }]}>{n.note}</Text>
                <View style={[s.noteBar, { width: `${Math.min(n.duration * 200, 100)}%`, backgroundColor: inst?.color + "40" }]} />
                <Text style={s.noteDur}>{n.duration}s</Text>
              </View>
            ))}
          </View>
        </View>

        <View style={s.infoRow}>
          {[
            { l: t("result.tempo"), v: t("result.bpmValue", { tempo }) },
            { l: t("result.key"), v: keyName },
            { l: t("result.notes"), v: `${totalNotes}` },
            { l: t("result.duration"), v: formatDuration(duration) },
          ].map((info) => (
            <View key={info.l} style={s.infoCard}><Text style={s.infoLabel}>{info.l}</Text><Text style={s.infoValue}>{info.v}</Text></View>
          ))}
        </View>

        <TouchableOpacity style={[s.dlBtn, downloading && { opacity: 0.6 }]} onPress={handleDownloadPDF} disabled={downloading} activeOpacity={0.8}>
          {downloading ? (
            <View style={s.dlBtnRow}><ActivityIndicator color={colors.white} /><Text style={s.dlBtnText}>{"  "}{t("result.downloading")}</Text></View>
          ) : (
            <Text style={s.dlBtnText}>📥  {t("result.downloadPdf")}</Text>
          )}
        </TouchableOpacity>

        <View style={s.actRow}>
          <TouchableOpacity style={[s.actBtn, downloading && { opacity: 0.6 }]} onPress={handleDownloadMIDI} disabled={downloading}><Text style={s.actBtnText}>🎵 {t("result.midi")}</Text></TouchableOpacity>
          <TouchableOpacity style={[s.actBtn, downloading && { opacity: 0.6 }]} onPress={handleShare} disabled={downloading}><Text style={s.actBtnText}>📤 {t("result.share")}</Text></TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (c) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg }, scroll: { padding: 20, paddingBottom: 30 },
  header: { flexDirection: "row", alignItems: "center", marginBottom: 16 },
  backBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: c.surface, alignItems: "center", justifyContent: "center" }, backText: { fontSize: 20, color: c.text },
  headerCenter: { flex: 1, alignItems: "center" }, headerTitle: { fontSize: 18, fontWeight: "700", color: c.text }, headerSub: { fontSize: 12, color: c.textSecondary, marginTop: 2 },
  adaptRow: { backgroundColor: c.surfaceLight, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12, marginBottom: 12 },
  adaptText: { fontSize: 12, color: c.textSecondary, fontWeight: "500" },
  sheet: { borderRadius: 16, borderWidth: 1, backgroundColor: c.surface, padding: 16, marginBottom: 16, minHeight: 200 },
  notesList: { gap: 6 },
  notesTitle: { fontSize: 13, fontWeight: "600", marginBottom: 8 },
  noteRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  noteLabel: { fontSize: 11, fontWeight: "600", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, minWidth: 50, textAlign: "center" },
  noteBar: { height: 6, borderRadius: 3 },
  noteDur: { fontSize: 10, color: c.textMuted, minWidth: 35 },
  infoRow: { flexDirection: "row", gap: 8, marginBottom: 20 },
  infoCard: { flex: 1, padding: 10, borderRadius: 12, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, alignItems: "center" },
  infoLabel: { fontSize: 10, color: c.textSecondary }, infoValue: { fontSize: 15, fontWeight: "700", color: c.text, marginTop: 2 },
  dlBtn: { backgroundColor: c.primary, borderRadius: 14, paddingVertical: 16, alignItems: "center", marginBottom: 10 }, dlBtnText: { color: c.white, fontSize: 15, fontWeight: "700" },
  dlBtnRow: { flexDirection: "row", alignItems: "center" },
  actRow: { flexDirection: "row", gap: 8 }, actBtn: { flex: 1, paddingVertical: 14, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, alignItems: "center" },
  actBtnText: { color: c.text, fontSize: 13 },
});
