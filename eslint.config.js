// eslint.config.js
import globals from "globals";
import pluginJs from "@eslint/js";
import noFloatingPromise from "eslint-plugin-no-floating-promise";

/** @type {import('eslint').Linter.Config[]} */
export default [
  // First, import the recommended configuration
  pluginJs.configs.recommended,

  // Then override or customize specific rules
  {
    plugins: {
      "no-floating-promise": noFloatingPromise,
    },
    languageOptions: {
      // ★ 2026-11-05（T03 / 报告第 11 条）：globals.browser → globals.node。
      //   这个仓库跑在 Node 里（mineflayer / fs / socket），浏览器全局一个都不用。
      //   用 browser 的后果是：no-undef 57 条里 51 条是误报（process / __dirname 之类被判未定义），
      //   真问题被埋在噪音里。
      //
      // ★ 2026-11-05（T04 / 队长裁决 5）：显式声明 SES 的 `Compartment`。
      //   `src/agent/library/lockdown.js:25` 用了 `Compartment`，它不是本项目代码里的符号，
      //   也不是 Node 内置全局 —— 是 **ses/lockdown 在运行时注入**的全局（SES 的 compartment 机制）。
      //   不声明的话它会一直挂在 no-undef 里，让「no-undef 剩余数 = 纯真问题」这个指标失真
      //   （T90 要用 `no-undef = 0` 判定，混进一条假阳性就永远归不了零）。
      globals: {
        ...globals.node,
        Compartment: "readonly",   // 由 ses lockdown 在运行时提供，只读
      },
      // ecmaVersion 2021 解析不了较新的语法（class field 等），直接造成 src/models/
      // 20 条 "Parsing error" —— 解析失败 = 那个文件根本没被 lint 过。
      // "latest" 让 eslint 用自带解析器的最新语法，不再手工追版本。
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      "no-undef": "error",              // Disallow the use of undeclared variables or functions.
      "semi": ["error", "always"],      // Require the use of semicolons at the end of statements.
      "curly": "off",                   // Do not enforce the use of curly braces around blocks of code.
      "no-unused-vars": "off",          // Disable warnings for unused variables.
      "no-unreachable": "off",          // Disable warnings for unreachable code.
      "require-await": "error",         // Disallow async functions which have no await expression
      "no-floating-promise/no-floating-promise": "error", // Disallow Promises without error handling or awaiting
    },
  },
];
