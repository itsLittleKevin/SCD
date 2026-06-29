import zh from "./locales/zh/common.json";
import en from "./locales/en/common.json";

export type Lang = "zh" | "en";
export type I18nKey = keyof typeof zh;

type Dictionary = Record<Lang, Record<I18nKey, string>>;

const dictionary: Dictionary = {
  zh,
  en,
};

export const t = (lang: Lang, key: I18nKey): string => {
  const current = dictionary[lang]?.[key];
  if (current) {
    return current;
  }

  const fallback = dictionary.en[key];
  return fallback ?? String(key);
};
