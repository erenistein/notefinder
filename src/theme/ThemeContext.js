// Tema altyapisi: React Context + ThemeProvider.
// mode: "light" | "dark" (varsayilan "dark" = mevcut gorunum). Sistem takibi YOK.
// Kalicilik: AsyncStorage anahtari notefindr_theme (dil sistemindeki notefindr_lang deseninin ayni).
import React, { createContext, useContext, useState, useEffect, useMemo } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { darkTokens, lightTokens } from "./tokens";

export const THEME_KEY = "notefindr_theme";
export const THEME_MODES = ["light", "dark"];

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [mode, setModeState] = useState("dark"); // varsayilan mevcut koyu gorunum

  // Acilista kayitli tercihi oku (async). Gecersiz/eski deger (orn. "system") -> "dark"da kal.
  useEffect(() => {
    AsyncStorage.getItem(THEME_KEY)
      .then((saved) => {
        if (saved && THEME_MODES.includes(saved)) setModeState(saved);
      })
      .catch(() => {});
  }, []);

  // Tercihi degistir + kalici yaz.
  const setMode = (m) => {
    if (!THEME_MODES.includes(m)) return;
    setModeState(m);
    AsyncStorage.setItem(THEME_KEY, m).catch(() => {});
  };

  const colors = mode === "dark" ? darkTokens : lightTokens;
  const value = useMemo(() => ({ mode, setMode, colors }), [mode, colors]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme, ThemeProvider icinde kullanilmali");
  return ctx;
}
