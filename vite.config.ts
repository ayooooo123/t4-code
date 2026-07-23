import { defineConfig } from "vite-plus";

const ignored = ["reference/**", "third_party/**", "**/node_modules/**", "**/dist/**", "**/build/**", "**/out/**", "**/coverage/**", "**/release/**"];

export default defineConfig({
  lint: {
    ignorePatterns: ignored,
    rules: {
      "no-unused-vars": "error",
      "no-control-regex": "error",
      "unicorn/no-useless-spread": "error",
      "unicorn/no-useless-fallback-in-spread": "error",
      "unicorn/no-thenable": "error",
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
});
