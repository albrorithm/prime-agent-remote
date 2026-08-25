/*
 * Stamps the persisted theme, motion, and text scale onto <html> before first
 * paint, so a light-theme user does not get a dark flash on every launch.
 *
 * This is a real file rather than an inline <script> because the gateway sends
 * `script-src 'self'` with no 'unsafe-inline' (src/server/gateway.ts). It must
 * stay in STATIC_SHELL in public/sw.js so it is precached and available
 * offline, and it must load before the app bundle.
 *
 * Keep the storage key, the stamped values, and the theme-color pair in sync
 * with src/web/settings.tsx (SETTINGS_KEY / THEME_COLORS / applySettings). This
 * file deliberately duplicates that small amount of logic: it has to run before
 * any module does.
 */
(function () {
  var TEXT_SCALES = [1, 1.15, 1.3];
  var theme = "system";
  var scale = 1;
  var motion = "system";

  try {
    var raw = localStorage.getItem("prime-web-settings");
    if (raw && raw.length <= 10000) {
      var stored = JSON.parse(raw);
      if (stored && typeof stored === "object") {
        if (stored.theme === "dark" || stored.theme === "light" || stored.theme === "system") {
          theme = stored.theme;
        }
        if (stored.reduceMotion === "always" || stored.reduceMotion === "system") {
          motion = stored.reduceMotion;
        }
        if (typeof stored.textScale === "number" && isFinite(stored.textScale)) {
          scale = TEXT_SCALES.reduce(function (best, value) {
            return Math.abs(value - stored.textScale) < Math.abs(best - stored.textScale) ? value : best;
          });
        }
      }
    }
  } catch (error) {
    // Storage unavailable or the payload is not JSON; fall through to defaults.
  }

  var resolved = theme;
  if (theme === "system") {
    var prefersDark = true;
    try {
      prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch (error) {
      // Treat an unusable matchMedia as dark, matching the app's default.
    }
    resolved = prefersDark ? "dark" : "light";
  }

  var root = document.documentElement;
  root.setAttribute("data-theme", resolved);
  root.setAttribute("data-reduce-motion", motion);
  root.style.setProperty("--text-scale", String(scale));

  // iOS reads theme-color at launch to tint the standalone status bar, so this
  // has to land before paint too, not on the first React render.
  var themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.setAttribute("content", resolved === "light" ? "#fdfcfa" : "#000000");
})();
