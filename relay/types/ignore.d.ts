// CJS-compatible ambient declaration for the `ignore` package (NodeNext build).
// The package ships an ESM-style `export default` but is a CJS module.
// Using `export =` here tells TypeScript NodeNext that `module.exports = ignore`.
declare module "ignore" {
  interface Ignore {
    add(patterns: string | Ignore | readonly (string | Ignore)[]): this;
    filter(pathnames: readonly string[]): string[];
    createFilter(): (pathname: string) => boolean;
    ignores(pathname: string): boolean;
    test(pathname: string): { ignored: boolean; unignored: boolean };
  }
  interface Options {
    ignorecase?: boolean;
    ignoreCase?: boolean;
    allowRelativePaths?: boolean;
  }
  function ignore(options?: Options): Ignore;
  namespace ignore {
    function isPathValid(pathname: string): boolean;
  }
  export = ignore;
}
