// Apply before styles paint to avoid flashing the wrong theme on reload.
(() => {
  const key = "truewatch:theme";
  const choices = new Set(["light", "dark"]);
  let preference = "light";
  try {
    const saved = localStorage.getItem(key);
    if (choices.has(saved)) preference = saved;
    else if (window.matchMedia("(prefers-color-scheme: dark)").matches) preference = "dark";
  } catch { /* Persistence is optional. */ }
  function apply() {
    const dark = preference === "dark";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.querySelector('meta[name="theme-color"]').content = dark ? "#141416" : "#f5f5f6";
    const button = document.getElementById("themeToggle");
    if (button) {
      button.setAttribute("aria-pressed", String(dark));
      button.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
      button.querySelector("span").textContent = dark ? "☀" : "☾";
    }
  }
  apply();
  document.addEventListener("DOMContentLoaded", () => {
    const button = document.getElementById("themeToggle");
    apply();
    if (!button) return;
    button.addEventListener("click", () => {
      preference = preference === "dark" ? "light" : "dark";
      try { localStorage.setItem(key, preference); } catch { /* Persistence is optional. */ }
      apply();
    });
  });
  window.addEventListener("storage", (event) => {
    if (event.key === key || event.key === null) {
      preference = choices.has(event.newValue) ? event.newValue : "light";
      apply();
    }
  });
})();
