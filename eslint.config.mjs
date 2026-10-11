/** @file Enforce TypeScript safety, naming and useful documentation without comment boilerplate. */
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import jsdoc from "eslint-plugin-jsdoc";
import tseslint from "typescript-eslint";

export default defineConfig([
  { ignores: ["**/dist/**", "coverage/**", ".superpowers/**", "node_modules/**"] },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { jsdoc },
    settings: { jsdoc: { mode: "typescript" } },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/naming-convention": [
        "error",
        { selector: "default", format: ["camelCase"] },
        { selector: "typeLike", format: ["PascalCase"] },
        {
          selector: "variable",
          modifiers: ["const", "global"],
          format: ["camelCase", "UPPER_CASE"],
        },
        { selector: "property", modifiers: ["requiresQuotes"], format: null },
      ],
      "jsdoc/require-file-overview": "error",
      "jsdoc/check-tag-names": "error",
      "jsdoc/check-param-names": "error",
      "jsdoc/require-param": ["error", { enableFixer: false }],
      "jsdoc/require-param-description": "error",
      "jsdoc/require-returns": "error",
      "jsdoc/require-returns-description": "error",
      "jsdoc/require-jsdoc": [
        "error",
        {
          enableFixer: false,
          contexts: [
            "TSInterfaceDeclaration",
            "TSTypeAliasDeclaration",
            "ExportNamedDeclaration[declaration.type='VariableDeclaration']",
          ],
          require: { FunctionDeclaration: true, ClassDeclaration: true },
        },
      ],
    },
  },
]);
