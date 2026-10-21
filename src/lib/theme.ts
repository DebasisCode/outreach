/** Light / dark theme, stored per browser. "system" follows the OS. */
export type ThemeChoice = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "outreach-theme";

/** Runs before the page paints, so a dark theme never flashes white. */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");var d=t==="dark"||((!t||t==="system")&&window.matchMedia("(prefers-color-scheme: dark)").matches);if(d)document.documentElement.classList.add("dark")}catch(e){}})();`;
