// Vite's ?raw suffix: a file's text, inlined at build time (test/config.test.ts reads wrangler.jsonc with it).
// In a file of its own because a wildcard module declaration only works in a script, not a module.
declare module '*?raw' {
  const content: string;
  export default content;
}
