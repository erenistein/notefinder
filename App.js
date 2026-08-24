import "./src/i18n"; // i18n'i mumkun oldugunca erken baslat (diger importlardan once)
import React, { useState, useEffect, useRef } from "react";
import { StatusBar, Text, View, Platform, TouchableOpacity, StyleSheet } from "react-native";
import { NavigationContainer, DefaultTheme, DarkTheme } from "@react-navigation/native";
import { createBottomTabNavigator, BottomTabBar } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { ThemeProvider, useTheme } from "./src/theme/ThemeContext";
import { getJobs, getJob, reconcileProcessingJobs } from "./src/services/jobs";

import HomeScreen from "./src/screens/HomeScreen";
import LoadingScreen from "./src/screens/LoadingScreen";
import ResultScreen from "./src/screens/ResultScreen";
import HistoryScreen from "./src/screens/HistoryScreen";
import SettingsScreen from "./src/screens/SettingsScreen";

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

// react-navigation v7 tema 'fonts' anahtari zorunlu — sistem fontlari.
const NAV_FONTS = {
  regular: { fontFamily: Platform.OS === "web" ? "system-ui" : "System", fontWeight: "400" },
  medium: { fontFamily: Platform.OS === "web" ? "system-ui" : "System", fontWeight: "500" },
  bold: { fontFamily: Platform.OS === "web" ? "system-ui" : "System", fontWeight: "700" },
  heavy: { fontFamily: Platform.OS === "web" ? "system-ui" : "System", fontWeight: "900" },
};

function HomeStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="HomeMain" component={HomeScreen} />
      <Stack.Screen name="Loading" component={LoadingScreen} options={{ gestureEnabled: false }} />
      <Stack.Screen name="Result" component={ResultScreen} />
      <Stack.Screen name="Settings" component={SettingsScreen} />
    </Stack.Navigator>
  );
}

function HistoryStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="HistoryMain" component={HistoryScreen} />
      <Stack.Screen name="Loading" component={LoadingScreen} options={{ gestureEnabled: false }} />
      <Stack.Screen name="Result" component={ResultScreen} />
    </Stack.Navigator>
  );
}

// Aktif (processing) is varsa tab bar USTUNDE ince "İşleniyor · %70 — dokun" cubugu.
// Her 4 sn'de storage + backend'i yoklar; dokununca Loading'e goturur; is bitince kaybolur.
function ActiveJobBar({ navigation }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [active, setActive] = useState(null);
  const [progress, setProgress] = useState(0);
  const timerRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const tick = async () => {
      try {
        const list = await getJobs();
        const p = list.find((j) => j.status === "processing");
        if (!p) {
          if (mountedRef.current) setActive(null);
        } else {
          const job = await getJob(p.jobId);
          if (!mountedRef.current) return;
          if (job && (job.status === "done" || job.status === "failed")) {
            await reconcileProcessingJobs().catch(() => {}); // storage guncelle + bildirim
            setActive(null);
          } else {
            setActive({ jobId: p.jobId, title: p.title, instrument: p.instrument });
            if (job && typeof job.progress === "number") setProgress(job.progress);
          }
        }
      } catch (e) { /* sessiz */ }
      timerRef.current = setTimeout(tick, 4000);
    };
    tick();
    return () => { mountedRef.current = false; if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  if (!active) return null;
  const s = barStyles(colors);
  return (
    <TouchableOpacity
      style={s.bar}
      activeOpacity={0.8}
      onPress={() => navigation.navigate("Home", { screen: "Loading", params: { jobId: active.jobId, instrument: active.instrument, title: active.title } })}
    >
      <Text style={s.text} numberOfLines={1}>🎵 {t("home.processingBar", { progress: Math.round(progress) })}</Text>
    </TouchableOpacity>
  );
}

const barStyles = (c) => StyleSheet.create({
  bar: { backgroundColor: c.surface, borderTopWidth: 1, borderTopColor: c.border, paddingVertical: 10, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", justifyContent: "center" },
  text: { color: c.primary, fontSize: 13, fontWeight: "700" },
});

// Navigator + chrome (tab bar, StatusBar, nav teması) — ThemeProvider'IN ICINDE,
// boylece useTheme burada calisir ve tema degisince renkler aninda guncellenir.
function AppNavigator() {
  const { t } = useTranslation();
  const { colors, mode } = useTheme();

  const base = mode === "dark" ? DarkTheme : DefaultTheme;
  const navTheme = {
    ...base,
    dark: mode === "dark",
    fonts: NAV_FONTS,
    colors: {
      ...base.colors,
      primary: colors.primary,
      background: colors.bg, // gecislerde beyaz/siyah flash olmasin
      card: colors.bg,
      text: colors.text,
      border: colors.border,
      notification: colors.danger,
    },
  };

  return (
    <>
      <StatusBar barStyle={mode === "dark" ? "light-content" : "dark-content"} backgroundColor={colors.bg} />
      <NavigationContainer theme={navTheme}>
        <Tab.Navigator
          tabBar={(props) => (
            <>
              <ActiveJobBar navigation={props.navigation} />
              <BottomTabBar {...props} />
            </>
          )}
          screenOptions={({ route }) => ({
            headerShown: false,
            tabBarStyle: { backgroundColor: colors.bg, borderTopColor: colors.border, borderTopWidth: 1, height: 70, paddingBottom: 12, paddingTop: 6 },
            tabBarActiveTintColor: colors.primary,
            tabBarInactiveTintColor: colors.textSecondary,
            tabBarLabelStyle: { fontSize: 10, fontWeight: "600" },
            tabBarIcon: ({ focused }) => {
              // Ikon lookup'i artik SABIT route kimliklerine gore (dilden bagimsiz).
              const icons = { Home: focused ? "🏠" : "🏡", History: focused ? "📁" : "📂" };
              return <View style={{ alignItems: "center" }}><Text style={{ fontSize: 22 }}>{icons[route.name] || "📱"}</Text></View>;
            },
          })}
        >
          <Tab.Screen name="Home" component={HomeStack} options={{ tabBarLabel: t("tabs.home") }} />
          <Tab.Screen name="History" component={HistoryStack} options={{ tabBarLabel: t("tabs.history") }} />
        </Tab.Navigator>
      </NavigationContainer>
    </>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <SafeAreaProvider>
        <AppNavigator />
      </SafeAreaProvider>
    </ThemeProvider>
  );
}
