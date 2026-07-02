import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";
import { baseEslintConfig } from "@strumm/config/eslint";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...baseEslintConfig,
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { "caughtErrors": "none", "ignoreRestSiblings": true }],
      "react-hooks/exhaustive-deps": "off",
      "@next/next/no-img-element": "off",
      "jsx-a11y/alt-text": "off"
    }
  }
];

export default eslintConfig;
