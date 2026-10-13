// Parser-blocking and dependency-free: restore appearance before the splash's first paint.
(function () {
  var root = document.documentElement;
  function read(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch (_) {
      return null;
    }
  }
  var preferences =
    read("suivelle.preferences") || read("takoception.preferences") || {};
  if (preferences.theme === "light" || preferences.theme === "dark")
    root.dataset.theme = preferences.theme;
  var cached = read("suivelle.startup-appearance");
  var theme = read("suivelle.themes.v1") || {};
  var palettes = (theme.config && theme.config.palettes) || {};
  var defaults = {
    background: ["#F7F6F2", "#0C1329"],
    "text-primary": ["#151B2E", "#E8EDF8"],
    "surface-1": ["#FFFFFF", "#131C3A"],
    border: ["#DCDCD9", "#172338"],
    "accent-ui": ["#1C3270", "#A9C4FF"],
    accent: ["#2A4694", "#3B5BA9"],
  };
  var hex = /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i;
  Object.keys(defaults).forEach(function (role) {
    var value =
      cached &&
      cached.version === 1 &&
      cached.variables &&
      cached.variables["--" + role];
    if (
      typeof value === "string" &&
      /^light-dark\(#[\da-f]{3,8},\s*#[\da-f]{3,8}\)$/i.test(value)
    ) {
      root.style.setProperty("--" + role, value);
    } else {
      var light = palettes.light && palettes.light[role],
        dark = palettes.dark && palettes.dark[role];
      root.style.setProperty(
        "--" + role,
        "light-dark(" +
          (hex.test(light) ? light : defaults[role][0]) +
          ", " +
          (hex.test(dark) ? dark : defaults[role][1]) +
          ")",
      );
    }
  });
})();
