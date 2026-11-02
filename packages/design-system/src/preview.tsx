import addonA11y from "@storybook/addon-a11y";
import addonDocs from "@storybook/addon-docs";
import { definePreview } from "@storybook/react-vite";
import { HOST_THEMES, type HostThemePreset } from "./host-themes";
import "./tokens.css";

/**
 * Globals for a dark-theme story variant. The preview decorator below derives
 * `data-theme="dark"` from the backgrounds global, so a Dark story needs only
 * `globals: darkGlobals` (spread it when combining with other globals) — never
 * a per-story `data-theme` decorator.
 */
export const darkGlobals = {
  backgrounds: { value: "dark" },
} as const;

/** Collect every CSS variable key used across all theme presets */
const ALL_HOST_KEYS = new Set(
  Object.values(HOST_THEMES)
    .filter((t): t is HostThemePreset => t !== null)
    .flatMap((t) => [...Object.keys(t.light), ...Object.keys(t.dark)]),
);

export default definePreview({
  addons: [addonA11y(), addonDocs()],
  parameters: {
    // Per-story axe checks: the addon panel reports violations in dev, and
    // the vitest story tests run the same checks in CI. Gated at "error"
    // repo-wide, so a violation fails the build wherever it appears and a new
    // package inherits the gate rather than opting into it. Do not add a
    // per-file `a11y` parameter to route a violation around this.
    a11y: { test: "error" },
    viewport: {
      options: {
        iphone16pro: {
          name: "iPhone 16 Pro",
          styles: { width: "402px", height: "874px" },
          type: "mobile",
        },
        claudeIosCard: {
          name: "Claude iOS Card",
          styles: { width: "360px", height: "780px" },
          type: "mobile",
        },
      },
    },
  },
  globalTypes: {
    hostTheme: {
      description: "Simulate MCP host CSS variable overrides",
      toolbar: {
        title: "Host Theme",
        icon: "paintbrush",
        items: [
          { value: "none", title: "Default (no host)" },
          { value: "claude", title: "Claude" },
          { value: "chatgpt", title: "ChatGPT" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: {
    backgrounds: { value: "light" },
    hostTheme: "none",
  },
  decorators: [
    (StoryFn, context) => {
      const isDark = context.globals?.backgrounds?.value === "dark";
      const dataTheme = isDark ? "dark" : "light";
      const hostKey = (context.globals?.hostTheme as string) ?? "none";
      const theme = HOST_THEMES[hostKey] ?? null;
      const vars = theme ? (isDark ? theme.dark : theme.light) : {};

      // Apply host variables to :root (mirrors what useHostStyles does in production)
      // This lets the Storybook canvas body pick up --color-background-primary
      const root = document.documentElement;
      // ...and the theme too, which ext-apps' useDocumentTheme reads there.
      root.setAttribute("data-theme", dataTheme);
      // Clear previous theme variables first
      for (const key of ALL_HOST_KEYS) {
        root.style.removeProperty(key);
      }
      // Set current theme variables
      for (const [key, value] of Object.entries(vars)) {
        root.style.setProperty(key, value);
      }
      // Set canvas background to host background when a theme is active
      // Use cssText with !important to override the backgrounds addon
      if (theme) {
        document.body.style.cssText =
          "background: var(--color-background-primary) !important;";
      } else {
        document.body.style.cssText = "";
      }

      return (
        // The wrapper paints the app's own surface color so the theme
        // simulation is self-contained: the backgrounds addon doesn't reach
        // the vitest browser-mode test root, and without a painted surface
        // axe would measure dark-mode text against a white canvas.
        <div
          data-theme={dataTheme}
          style={{ background: "var(--color-background-primary)" }}
        >
          <StoryFn />
        </div>
      );
    },
  ],
});
