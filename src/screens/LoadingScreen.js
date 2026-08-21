import React, { useState, useEffect, useRef, useMemo } from "react";
import { View, Text, StyleSheet, Animated, Easing } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "../theme/ThemeContext";

const STEPS = [
  { text: "Ses dosyası indiriliyor...", icon: "📥" },
  { text: "Frekanslar analiz ediliyor...", icon: "📊" },
  { text: "Notalar çıkarılıyor...", icon: "🎵" },
  { text: "Nota kağıdı oluşturuluyor...", icon: "📄" },
  { text: "PDF hazırlanıyor...", icon: "✅" },
];

export default function LoadingScreen({ navigation, route }) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [progress, setProgress] = useState(0);
  const [currentStep, setCurrentStep] = useState(0);
  const spinAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => { Animated.loop(Animated.timing(spinAnim, { toValue: 1, duration: 2000, easing: Easing.linear, useNativeDriver: true })).start(); }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setProgress((prev) => {
        if (prev >= 100) { clearInterval(interval); setTimeout(() => { navigation.replace("Result", { instrument: route.params?.instrument || "piano", title: "Yeni Şarkı" }); }, 800); return 100; }
        setCurrentStep(Math.min(Math.floor(prev / 20), 4));
        return prev + 1.5;
      });
    }, 100);
    return () => clearInterval(interval);
  }, []);

  const spin = spinAnim.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });

  return (
    <SafeAreaView style={s.container}>
      <View style={s.content}>
        <Animated.Text style={[s.spinIcon, { transform: [{ rotate: spin }] }]}>🎵</Animated.Text>
        <Text style={s.title}>Notaların çıkarılıyor</Text>
        <Text style={s.subtitle}>Bu işlem birkaç dakika sürebilir</Text>
        <View style={s.barBg}><View style={[s.barFill, { width: `${progress}%` }]} /></View>
        <Text style={s.pctText}>{Math.round(progress)}%</Text>
        <View style={s.steps}>
          {STEPS.map((step, i) => (
            <View key={i} style={[s.stepRow, { opacity: i <= currentStep ? 1 : 0.25 }]}>
              <Text style={s.stepIcon}>{step.icon}</Text>
              <Text style={[s.stepText, i === currentStep && s.stepActive]}>{step.text}</Text>
              {i < currentStep && <Text style={s.stepCheck}>✓</Text>}
              {i === currentStep && <Text style={s.stepPct}>{Math.min(Math.round((progress - i * 20) * 5), 100)}%</Text>}
            </View>
          ))}
        </View>
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (c) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg }, content: { flex: 1, padding: 30, alignItems: "center", justifyContent: "center" },
  spinIcon: { fontSize: 60, marginBottom: 24 }, title: { fontSize: 20, fontWeight: "700", color: c.text, marginBottom: 6 },
  subtitle: { fontSize: 13, color: c.textSecondary, marginBottom: 30 },
  barBg: { width: "100%", height: 6, borderRadius: 3, backgroundColor: c.border, overflow: "hidden", marginBottom: 8 },
  barFill: { height: "100%", borderRadius: 3, backgroundColor: c.primary },
  pctText: { fontSize: 12, color: c.textSecondary, marginBottom: 30 }, steps: { width: "100%" },
  stepRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, gap: 10 }, stepIcon: { fontSize: 18 },
  stepText: { flex: 1, fontSize: 13, color: c.text }, stepActive: { fontWeight: "700" },
  stepCheck: { color: c.success, fontSize: 16, fontWeight: "700" }, stepPct: { fontSize: 11, color: c.textSecondary },
});
