import { HOST_THEMES } from "@intervals-mcp/design-system/host-themes";
import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";

const colorVars = [
  "--color-background-primary",
  "--color-background-secondary",
  "--color-background-tertiary",
  "--color-text-primary",
  "--color-text-secondary",
  "--color-text-tertiary",
  "--color-border-primary",
  "--color-border-secondary",
  "--color-border-tertiary",
];

function Swatch({ variable }: { variable: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        marginBottom: 8,
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: "var(--border-radius-sm)",
          backgroundColor: `var(${variable})`,
          border: "1px solid var(--color-border-secondary)",
          flexShrink: 0,
        }}
      />
      <code
        style={{
          fontSize: "var(--font-text-xs-size)",
          // Secondary, not tertiary: this is the swatch's only label, and
          // tertiary at 12px falls under 4.5:1 in some host palettes (#286).
          color: "var(--color-text-secondary)",
        }}
      >
        {variable}
      </code>
    </div>
  );
}

function SampleCard() {
  return (
    <div
      style={{
        padding: 16,
        background: "var(--color-background-secondary)",
        borderRadius: "var(--border-radius-md)",
        border: "1px solid var(--color-border-tertiary)",
        boxShadow: "var(--shadow-md)",
        fontFamily: "var(--font-sans)",
        maxWidth: 320,
        marginBottom: 24,
      }}
    >
      <div
        style={{
          fontSize: "var(--font-heading-sm-size)",
          fontWeight: "var(--font-weight-semibold)",
          color: "var(--color-text-primary)",
          marginBottom: 4,
        }}
      >
        Sample Card
      </div>
      <div
        style={{
          fontSize: "var(--font-text-sm-size)",
          color: "var(--color-text-secondary)",
        }}
      >
        This card uses design tokens. Switch the host theme global to preview
        how it looks with different host variable overrides.
      </div>
    </div>
  );
}

function HostThemesDemo() {
  return (
    <div style={{ fontFamily: "var(--font-sans)", padding: 24 }}>
      <p
        style={{
          fontSize: "var(--font-text-sm-size)",
          color: "var(--color-text-secondary)",
          marginBottom: 24,
        }}
      >
        Use the <strong>hostTheme</strong> Storybook global (toolbar or URL
        param <code>?globals=hostTheme:claude</code>) to switch host theme.
        Available: {Object.keys(HOST_THEMES).join(", ")}
      </p>
      <SampleCard />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          gap: 8,
        }}
      >
        {colorVars.map((v) => (
          <Swatch key={v} variable={v} />
        ))}
      </div>
    </div>
  );
}

const meta = preview.meta({
  title: "Design System/Host Themes",
  component: HostThemesDemo,
});

export const Default = meta.story({});

export const Claude = meta.story({
  globals: { hostTheme: "claude" },
});

export const ClaudeDark = meta.story({
  globals: {
    ...darkGlobals,
    hostTheme: "claude",
  },
});

export const ChatGPT = meta.story({
  globals: { hostTheme: "chatgpt" },
});

export const ChatGPTDark = meta.story({
  globals: {
    ...darkGlobals,
    hostTheme: "chatgpt",
  },
});
