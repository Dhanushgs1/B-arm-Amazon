/**
 * Build guard: the `dark:` variant must be bound to the .dark class.
 *
 * Tailwind v4 defaults `dark:` to `@media (prefers-color-scheme: dark)`, but
 * this app switches themes by toggling a `.dark` class on <html> (TopNav and
 * the settings page). When the two disagree, card backgrounds follow the app
 * toggle while text colours follow the operating system — so on a machine set
 * to OS dark mode with the app in light theme, dark:text-white lands on white
 * cards and the text becomes invisible. That shipped to a client once.
 *
 * Losing the @custom-variant line breaks this silently: it still compiles, and
 * anyone whose OS is in light mode sees nothing wrong. Hence a build-time check.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cssPath = join(root, "src", "app", "globals.css");

const css = readFileSync(cssPath, "utf8");

// Matches `@custom-variant dark (...)` however the selector inside is spelled.
const declared = /@custom-variant\s+dark\s*\(/.test(css);

if (!declared) {
  console.error(
    [
      "",
      "  Theme check failed: src/app/globals.css has no `@custom-variant dark (...)`.",
      "",
      "  Without it Tailwind v4 drives `dark:` off the operating system setting",
      "  instead of the .dark class this app toggles, and text colours stop",
      "  matching card backgrounds — invisible text for anyone on OS dark mode.",
      "",
      "  Restore this line just below `@import \"tailwindcss\";`:",
      "",
      "    @custom-variant dark (&:where(.dark, .dark *));",
      "",
    ].join("\n")
  );
  process.exit(1);
}

console.log("Theme check passed: dark: variant is bound to the .dark class.");
