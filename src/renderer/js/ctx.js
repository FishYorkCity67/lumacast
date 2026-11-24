// Shared runtime handles, filled in by app.js: audio, mgr, compositor, output,
// chat, automation, actions, panels.
export const app = { panels: [] };

export function registerPanel(panel) {
  app.panels.push(panel);
  return panel;
}

export function rerenderAll() {
  for (const p of app.panels) {
    try { p.render(); } catch (err) { console.error('panel render', err); }
  }
}
