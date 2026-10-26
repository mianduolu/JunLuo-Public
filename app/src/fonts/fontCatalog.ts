export type FontChoice = 'system' | 'xiaolai';

export type FontOption = {
  value: FontChoice;
  label: string;
  description: string;
};

export const fontOptions: FontOption[] = [
  {
    value: 'system',
    label: '跟随系统',
    description: '使用手机当前默认字体',
  },
  {
    value: 'xiaolai',
    label: '小赖字体',
    description: '轻轻软软的手写风格',
  },
];

export const customFontSources = {
  Xiaolai: require('../../assets/fonts/Xiaolai-Regular.ttf'),
};

export function isFontChoice(value: string | null): value is FontChoice {
  return fontOptions.some((font) => font.value === value);
}

export function getFontFamily(choice: FontChoice) {
  return choice === 'xiaolai' ? 'Xiaolai' : undefined;
}
