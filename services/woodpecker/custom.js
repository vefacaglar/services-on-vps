// Dark by default. Woodpecker follows the operating system ("auto") until a
// theme is chosen; this runs before the app starts and turns "auto" or no
// choice into dark. Light stays selectable in the user settings.
try {
  var theme = localStorage.getItem('woodpecker:theme');
  if (theme === null || theme === 'auto') {
    localStorage.setItem('woodpecker:theme', 'dark');
  }
} catch (error) {
  // Storage blocked: Woodpecker keeps following the system theme.
}
