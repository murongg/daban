import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { en } from '../../locales/en';
import { zh } from '../../locales/zh-CN';

export type MessageKey = keyof typeof en;
export type Translate = (key: MessageKey, value?: string | number) => string;
const translate =
  (language: 'zh' | 'en'): Translate =>
  (key, value) =>
    (language === 'zh' ? zh : en)[key].replace('{0}', String(value ?? ''));
const Context = createContext<Translate>(translate('zh'));
export function Messages({ children }: { children: ReactNode }) {
  // The static document and first hydration render must use the same language.
  const [language, setLanguage] = useState<'zh' | 'en'>('zh');
  useEffect(() => {
    const next = navigator.language.startsWith('zh') ? 'zh' : 'en';
    setLanguage(next);
    document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';
  }, []);
  return <Context value={translate(language)}>{children}</Context>;
}
export const useMessages = () => useContext(Context);
