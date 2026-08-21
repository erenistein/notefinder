import React, { useState, useMemo } from "react";
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Modal } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import i18n, { setAppLanguage } from "../i18n";
import { useTheme } from "../theme/ThemeContext";

// Dil secenekleri: endonim (kendi dilinde) gosterilir - konvansiyon boyle.
const LANGUAGES = [
  { code: "tr", label: "Türkçe" },
  { code: "en", label: "English" },
];

export default function SettingsScreen({ navigation }) {
  const { t } = useTranslation();
  const { colors, mode, setMode } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [langModalVisible, setLangModalVisible] = useState(false);
  const [themeModalVisible, setThemeModalVisible] = useState(false);
  // Bilgi modali: null | "privacy" | "about"
  const [infoModal, setInfoModal] = useState(null);

  // Tema secenekleri (etiketler aktif dile gore).
  const themeOptions = [
    { key: "light", label: t("settings.themeLight") },
    { key: "dark", label: t("settings.themeDark") },
  ];
  const currentThemeLabel = themeOptions.find((o) => o.key === mode)?.label;

  // Sadece calisan / anlamli ekran acan satirlar: Dil, Tema, Gizlilik, Hakkinda.
  const rows = [
    { icon: "🌐", label: t("settings.language"), value: t("settings.languageName"), type: "language" },
    { icon: "🎨", label: t("settings.theme"), value: currentThemeLabel, type: "theme" },
    { icon: "🔒", label: t("settings.privacy"), value: "", type: "privacy" },
    { icon: "ℹ️", label: t("settings.about"), value: "v0.1.0", type: "about" },
  ];

  const onRowPress = (type) => {
    if (type === "language") setLangModalVisible(true);
    else if (type === "theme") setThemeModalVisible(true);
    else setInfoModal(type); // "privacy" | "about"
  };

  const chooseLanguage = async (code) => {
    setLangModalVisible(false);
    await setAppLanguage(code); // AsyncStorage'a yaz + i18next dilini degistir (aninda re-render)
  };

  const chooseTheme = (m) => {
    setThemeModalVisible(false);
    setMode(m); // AsyncStorage'a yaz + tema aninda degisir (ThemeProvider re-render)
  };

  // Bilgi modali icerigi (baslik + govde) aktif dile gore.
  const infoContent = {
    privacy: { title: t("settings.privacy"), body: t("settings.privacyBody") },
    about: { title: t("settings.about"), body: `NoteFindr  ·  v0.1.0\n\n${t("settings.aboutDescription")}\n\n${t("settings.developedFor")}` },
  };
  const info = infoModal ? infoContent[infoModal] : null;

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={s.backBtn} activeOpacity={0.7}>
          <Text style={s.backText}>←</Text>
        </TouchableOpacity>
        <Text style={s.headerTitle}>{t("settings.title")}</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={s.scroll}>
        <View style={s.card}>
          {rows.map((item, i) => (
            <TouchableOpacity
              key={i}
              style={[s.row, i < rows.length - 1 && s.rowBorder]}
              activeOpacity={0.7}
              onPress={() => onRowPress(item.type)}
            >
              <Text style={s.rowIcon}>{item.icon}</Text>
              <Text style={s.rowLabel}>{item.label}</Text>
              <View style={s.rowRight}><Text style={s.rowValue}>{item.value}</Text><Text style={s.rowArrow}>›</Text></View>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={s.footer}>NoteFindr v0.1.0{"\n"}{t("settings.developedFor")}</Text>
      </ScrollView>

      {/* Dil secici */}
      <Modal visible={langModalVisible} transparent animationType="fade" onRequestClose={() => setLangModalVisible(false)}>
        <TouchableOpacity style={s.modalOverlay} activeOpacity={1} onPress={() => setLangModalVisible(false)}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>{t("settings.languagePickerTitle")}</Text>
            {LANGUAGES.map((lang) => {
              const active = i18n.language === lang.code;
              return (
                <TouchableOpacity key={lang.code} style={[s.langRow, active && s.langRowActive]} onPress={() => chooseLanguage(lang.code)} activeOpacity={0.7}>
                  <Text style={[s.langLabel, active && { color: colors.white, fontWeight: "700" }]}>{lang.label}</Text>
                  {active && <Text style={s.langCheck}>✓</Text>}
                </TouchableOpacity>
              );
            })}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Tema secici */}
      <Modal visible={themeModalVisible} transparent animationType="fade" onRequestClose={() => setThemeModalVisible(false)}>
        <TouchableOpacity style={s.modalOverlay} activeOpacity={1} onPress={() => setThemeModalVisible(false)}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>{t("settings.theme")}</Text>
            {themeOptions.map((opt) => {
              const active = mode === opt.key;
              return (
                <TouchableOpacity key={opt.key} style={[s.langRow, active && s.langRowActive]} onPress={() => chooseTheme(opt.key)} activeOpacity={0.7}>
                  <Text style={[s.langLabel, active && { color: colors.white, fontWeight: "700" }]}>{opt.label}</Text>
                  {active && <Text style={s.langCheck}>✓</Text>}
                </TouchableOpacity>
              );
            })}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Gizlilik / Hakkinda bilgi modali */}
      <Modal visible={!!infoModal} transparent animationType="fade" onRequestClose={() => setInfoModal(null)}>
        <TouchableOpacity style={s.modalOverlay} activeOpacity={1} onPress={() => setInfoModal(null)}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>{info?.title}</Text>
            <ScrollView style={s.infoScroll} showsVerticalScrollIndicator={false}>
              <Text style={s.infoBody}>{info?.body}</Text>
            </ScrollView>
            <TouchableOpacity style={[s.langRow, s.langRowActive, { justifyContent: "center", marginTop: 6 }]} onPress={() => setInfoModal(null)} activeOpacity={0.8}>
              <Text style={[s.langLabel, { color: colors.white, fontWeight: "700" }]}>OK</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

const makeStyles = (c) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 },
  backBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: c.surface, alignItems: "center", justifyContent: "center" },
  backText: { fontSize: 20, color: c.text },
  headerTitle: { flex: 1, textAlign: "center", fontSize: 20, fontWeight: "700", color: c.text },
  scroll: { padding: 20, paddingBottom: 30 },
  card: { borderRadius: 16, backgroundColor: c.surface, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", padding: 16, gap: 12 }, rowBorder: { borderBottomWidth: 0.5, borderBottomColor: c.border },
  rowIcon: { fontSize: 20 }, rowLabel: { flex: 1, fontSize: 15, color: c.text },
  rowRight: { flexDirection: "row", alignItems: "center", gap: 4 }, rowValue: { fontSize: 14, color: c.textSecondary }, rowArrow: { fontSize: 20, color: c.textMuted },
  footer: { textAlign: "center", fontSize: 11, color: c.textMuted, marginTop: 30, lineHeight: 18 },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", alignItems: "center", justifyContent: "center", padding: 24 },
  modalCard: { width: "100%", maxWidth: 340, backgroundColor: c.surface, borderRadius: 16, borderWidth: 1, borderColor: c.border, padding: 20 },
  modalTitle: { fontSize: 17, fontWeight: "700", color: c.text, marginBottom: 14 },
  infoScroll: { maxHeight: 320 },
  infoBody: { fontSize: 14, color: c.textSecondary, lineHeight: 22, marginBottom: 16 },
  langRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 14, paddingHorizontal: 14, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.bg, marginBottom: 8 },
  langRowActive: { backgroundColor: c.primary, borderColor: c.primary },
  langLabel: { fontSize: 15, color: c.text },
  langCheck: { color: c.white, fontSize: 16, fontWeight: "700" },
});
