// 时间换算助手：把可读的「N 秒/分/时/天」转成毫秒，替代散落在多文件里的 *3600*1000 / *60*1000 魔数算术。
// 例：hours(6) === 6 小时的毫秒数。纯函数、零依赖。
export const seconds = (n: number): number => n * 1000;
export const minutes = (n: number): number => n * 60_000;
export const hours = (n: number): number => n * 3_600_000;
export const days = (n: number): number => n * 86_400_000;
