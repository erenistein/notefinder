import React, { useState, useCallback, useMemo } from "react";
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { useTheme } from "../theme/ThemeContext";
import { INSTRUMENTS } from "../constants";
import { getJobs, deleteJob, jobToResultParams } from "../utils/storage";
import { formatRelativeDate, formatDuration } from "../utils/date";

export default function HistoryScreen({ navigation }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [jobs, setJobs] = useState([]);

  const load = useCallback(async () => {
    setJobs(await getJobs());
  }, []);

  // Sekmeye HER geçişte tazele (yeni dönüştürme yapıp History'ye gelince güncel görünsün).
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const handleDelete = (job) => {
    Alert.alert(t("history.deleteTitle"), t("history.deleteMessage", { title: job.title }), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("history.deleteConfirm"),
        style: "destructive",
        onPress: async () => {
          await deleteJob(job.jobId);
          load();
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={s.container}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={s.scroll}>
        <Text style={s.pageTitle}>{t("history.title")}</Text>
        <Text style={s.pageSub}>{t("history.conversionCount", { count: jobs.length })}</Text>

        {jobs.length === 0 ? (
          <View style={s.empty}>
            <Text style={s.emptyIcon}>🎼</Text>
            <Text style={s.emptyTitle}>{t("history.emptyTitle")}</Text>
            <Text style={s.emptyText}>{t("history.emptyText")}</Text>
          </View>
        ) : (
          jobs.map((item) => {
            const inst = INSTRUMENTS.find((i) => i.id === item.instrument);
            return (
              <TouchableOpacity
                key={item.jobId}
                style={s.card}
                onPress={() => navigation.navigate("Result", jobToResultParams(item))}
                onLongPress={() => handleDelete(item)}
                delayLongPress={400}
                activeOpacity={0.7}
              >
                <View style={[s.iconBox, { backgroundColor: (inst?.color || colors.primary) + "20" }]}>
                  <Text style={s.icon}>{inst?.icon || "🎵"}</Text>
                </View>
                <View style={s.cardInfo}>
                  <Text style={s.cardTitle} numberOfLines={1}>{item.title}</Text>
                  <Text style={s.cardMeta}>
                    {inst ? t(`instruments.${inst.id}`) : item.instrument} · {formatDuration(item.duration)} · {formatRelativeDate(item.createdAt)}
                  </Text>
                </View>
                {item.hasPdf ? (
                  <View style={s.pdfBadge}><Text style={s.pdfText}>PDF</Text></View>
                ) : null}
                <TouchableOpacity onPress={() => handleDelete(item)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} style={s.delBtn}>
                  <Text style={s.delText}>✕</Text>
                </TouchableOpacity>
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (c) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg }, scroll: { padding: 20, paddingBottom: 30 },
  pageTitle: { fontSize: 24, fontWeight: "700", color: c.text, marginBottom: 4 }, pageSub: { fontSize: 13, color: c.textSecondary, marginBottom: 20 },
  card: { flexDirection: "row", alignItems: "center", padding: 14, borderRadius: 14, backgroundColor: c.surface, marginBottom: 10, gap: 12 },
  iconBox: { width: 48, height: 48, borderRadius: 12, alignItems: "center", justifyContent: "center" }, icon: { fontSize: 24 },
  cardInfo: { flex: 1 }, cardTitle: { fontSize: 15, fontWeight: "600", color: c.text }, cardMeta: { fontSize: 11, color: c.textSecondary, marginTop: 3 },
  pdfBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, backgroundColor: c.primary + "20" }, pdfText: { fontSize: 11, fontWeight: "600", color: c.primary },
  delBtn: { width: 28, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: c.surfaceLight }, delText: { color: c.textSecondary, fontSize: 13, fontWeight: "700" },
  empty: { alignItems: "center", paddingVertical: 70 }, emptyIcon: { fontSize: 52, marginBottom: 14 },
  emptyTitle: { fontSize: 16, fontWeight: "700", color: c.text, marginBottom: 6 }, emptyText: { fontSize: 13, color: c.textSecondary, textAlign: "center", paddingHorizontal: 30 },
});
