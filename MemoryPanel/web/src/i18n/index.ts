// English interface, including previously saved Chinese language preferences.
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { enUS } from './en-US';

const STORAGE_KEY = 'tdai-memory.lang';

export function changeLanguage(_lang: string): void {
  i18n.changeLanguage('en-US');
  localStorage.setItem(STORAGE_KEY, 'en-US');
}

export function getCurrentLanguage(): string {
  return 'en-US';
}

i18n.use(initReactI18next).init({
  resources: {
    'en-US': { translation: enUS },
  },
  lng: 'en-US',
  fallbackLng: 'en-US',
  supportedLngs: ['en-US'],
  interpolation: {
    escapeValue: false,
  },
  react: {
    useSuspense: false,
  },
});

export default i18n;
