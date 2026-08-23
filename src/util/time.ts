// Time-conversion helpers: turn a readable "N seconds/minutes/hours/days" into milliseconds, replacing the
// *3600*1000 / *60*1000 magic-number arithmetic that was scattered across several files.
// For example hours(6) === six hours in milliseconds. Pure functions, no dependencies.
export const seconds = (n: number): number => n * 1000;
export const minutes = (n: number): number => n * 60_000;
export const hours = (n: number): number => n * 3_600_000;
export const days = (n: number): number => n * 86_400_000;
