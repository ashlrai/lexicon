/** esbuild inlines .yaml imports as text (see scripts/build-extension.mjs). */
declare module '*.yaml' {
  const text: string;
  export default text;
}
