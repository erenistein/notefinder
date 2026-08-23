// Yerel bildirim yardimcisi (expo-notifications). Modul yoksa/izin yoksa SESSIZCE atlar (crash yok).
// "Notaların hazır" bildirimi is bitince (bekleme ekrani veya odakta reconcile) tetiklenir.
let Notifications = null;
try {
  Notifications = require("expo-notifications");
} catch (e) {
  Notifications = null; // Expo Go/derleme bildirimi desteklemiyorsa uygulama yine calisir
}

let permAsked = false;

// Izin al (bir kez sor) + Android bildirim kanali. Doner: izin verildi mi.
export async function ensureNotifPermission() {
  if (!Notifications) return false;
  try {
    if (Notifications.setNotificationChannelAsync) {
      await Notifications.setNotificationChannelAsync("default", {
        name: "default",
        importance: (Notifications.AndroidImportance && Notifications.AndroidImportance.DEFAULT) || 3,
      });
    }
    const cur = await Notifications.getPermissionsAsync();
    let granted = !!cur.granted;
    if (!granted && !permAsked) {
      permAsked = true;
      const req = await Notifications.requestPermissionsAsync();
      granted = !!req.granted;
    }
    return granted;
  } catch (e) {
    return false;
  }
}

// Hemen yerel bildirim gonder. Izin/modul yoksa sessizce hicbir sey yapmaz.
export async function notifyReady(title, body) {
  if (!Notifications) return;
  try {
    const ok = await ensureNotifPermission();
    if (!ok) return;
    await Notifications.scheduleNotificationAsync({ content: { title, body }, trigger: null });
  } catch (e) {
    // bildirim gonderilemese bile akis bozulmasin
  }
}
