// English strings are the keys; German translations live in i18n-de.js.
import { DE } from './i18n-de.js';

let lang = 'en';

export function setLang(l) {
  lang = l === 'de' ? 'de' : 'en';
  document.documentElement.lang = lang;
}

export const getLang = () => lang;

export function t(s, vars) {
  let out = lang === 'de' ? (DE[s] ?? s) : s;
  if (vars) out = out.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
  return out;
}
