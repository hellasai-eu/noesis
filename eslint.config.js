import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    files: ["supabase/functions/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // Locale-sensitive built-ins, in the frontend only.
    //
    // Both silently follow the *runtime's* locale rather than the one the user
    // picked, so they look right on the machine that wrote them and wrong on a
    // Greek browser. Around ninety call sites had drifted in before anyone
    // noticed, which is what this rule is here to stop.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/i18n/formatters.ts"],
    rules: {
      "no-restricted-syntax": [
        "warn",
        {
          selector: "CallExpression[callee.property.name='localeCompare']",
          message:
            "localeCompare sorts by the runtime's collation, so two users can see the same list in different orders. Use compareText (display text) or compareCode (ids, ISO dates) from @/i18n/formatters.",
        },
        {
          selector:
            "CallExpression[callee.property.name=/^toLocale(Date|Time)?String$/][arguments.length=0]",
          message:
            "A bare toLocale*String follows the runtime's locale, not the app's. Use formatDate / formatDateTime / formatTime / formatNumber from @/i18n/formatters.",
        },
      ],
    },
  },
);
