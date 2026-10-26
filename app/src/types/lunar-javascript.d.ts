declare module 'lunar-javascript' {
  export type LunarSolar = {
    getYear(): number;
    getMonth(): number;
    getDay(): number;
  };

  export type LunarDate = {
    getYear(): number;
    getMonth(): number;
    getDay(): number;
    getSolar(): LunarSolar;
  };

  export const Lunar: {
    fromDate(date: Date): LunarDate;
    fromYmd(year: number, month: number, day: number): LunarDate;
  };
}
