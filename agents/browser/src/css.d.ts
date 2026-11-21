/** esbuild loads .css imports as text (scripts/build.mjs) */
declare module "*.css" {
  const text: string;
  export default text;
}
