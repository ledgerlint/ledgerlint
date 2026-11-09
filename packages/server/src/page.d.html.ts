/**
 * 与 `page.html` 同名的类型声明（TypeScript 的 `allowArbitraryExtensions` 约定：
 * 导入 `./page.html` 时，类型取自 `./page.d.html.ts`）。
 * 运行期不存在这个模块——esbuild 用 `--loader:.html=text` 把它内联成字符串。
 */
declare const content: string;
export default content;
