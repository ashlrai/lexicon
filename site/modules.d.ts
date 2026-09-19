/** esbuild inlines .yaml imports as text (see scripts/build-site.mjs). */
declare module '*.yaml' {
  const text: string;
  export default text;
}
