import preview from "@intervals-mcp/design-system/preview";

const allTokens = [
  {
    category: "Background",
    tokens: [
      { var: "--color-background-primary", light: "#ffffff", dark: "#30302e" },
      {
        var: "--color-background-secondary",
        light: "#f5f4ed",
        dark: "#262624",
      },
      { var: "--color-background-tertiary", light: "#faf9f5", dark: "#141413" },
      { var: "--color-background-inverse", light: "#141413", dark: "#faf9f5" },
    ],
  },
  {
    category: "Text",
    tokens: [
      { var: "--color-text-primary", light: "#14141a", dark: "#faf9f5" },
      { var: "--color-text-secondary", light: "#3d3d3a", dark: "#c2c0b6" },
      { var: "--color-text-tertiary", light: "#6e6d67", dark: "#9c9a92" },
      { var: "--color-text-danger", light: "#7f2c28", dark: "#ee8884" },
      { var: "--color-text-success", light: "#275b19", dark: "#7ab948" },
      { var: "--color-text-info", light: "#3266ad", dark: "#80aadd" },
    ],
  },
  {
    category: "Border",
    tokens: [
      {
        var: "--color-border-primary",
        light: "rgba(31,30,29,0.40)",
        dark: "rgba(222,220,209,0.40)",
      },
      {
        var: "--color-border-secondary",
        light: "rgba(31,30,29,0.30)",
        dark: "rgba(222,220,209,0.30)",
      },
      {
        var: "--color-border-tertiary",
        light: "rgba(31,30,29,0.15)",
        dark: "rgba(222,220,209,0.15)",
      },
    ],
  },
  {
    category: "Typography",
    tokens: [
      {
        var: "--font-sans",
        light: "system-ui, -apple-system, sans-serif",
        dark: "\u2014",
      },
      { var: "--font-mono", light: "ui-monospace, monospace", dark: "\u2014" },
      { var: "--font-weight-normal", light: "400", dark: "\u2014" },
      { var: "--font-weight-medium", light: "500", dark: "\u2014" },
      { var: "--font-weight-semibold", light: "600", dark: "\u2014" },
      { var: "--font-weight-bold", light: "700", dark: "\u2014" },
      { var: "--font-text-xs-size", light: "12px", dark: "\u2014" },
      { var: "--font-text-sm-size", light: "14px", dark: "\u2014" },
      { var: "--font-text-md-size", light: "16px", dark: "\u2014" },
      { var: "--font-heading-sm-size", light: "16px", dark: "\u2014" },
      { var: "--font-heading-md-size", light: "20px", dark: "\u2014" },
    ],
  },
  {
    category: "Border Radius",
    tokens: [
      { var: "--border-radius-xs", light: "2px", dark: "\u2014" },
      { var: "--border-radius-sm", light: "4px", dark: "\u2014" },
      { var: "--border-radius-md", light: "8px", dark: "\u2014" },
      { var: "--border-radius-lg", light: "12px", dark: "\u2014" },
      { var: "--border-radius-full", light: "9999px", dark: "\u2014" },
      { var: "--border-width-regular", light: "1px", dark: "\u2014" },
    ],
  },
  {
    category: "Spacing",
    tokens: [
      { var: "--space-0-5", light: "2px", dark: "\u2014" },
      { var: "--space-1", light: "4px", dark: "\u2014" },
      { var: "--space-1-5", light: "6px", dark: "\u2014" },
      { var: "--space-2", light: "8px", dark: "\u2014" },
      { var: "--space-3", light: "12px", dark: "\u2014" },
      { var: "--space-4", light: "16px", dark: "\u2014" },
      { var: "--space-6", light: "24px", dark: "\u2014" },
    ],
  },
  {
    category: "Line Height",
    tokens: [
      { var: "--line-height-tight", light: "1", dark: "\u2014" },
      { var: "--line-height-relaxed", light: "1.8", dark: "\u2014" },
    ],
  },
  {
    category: "Letter Spacing",
    tokens: [{ var: "--letter-spacing-wide", light: "0.05em", dark: "\u2014" }],
  },
  {
    category: "Chart",
    tokens: [
      { var: "--chart-heartrate", light: "#ef4444", dark: "#f87171" },
      { var: "--chart-power", light: "#8b5cf6", dark: "#a78bfa" },
      { var: "--chart-pace", light: "#3b82f6", dark: "#60a5fa" },
      { var: "--chart-altitude", light: "#b8a48c", dark: "#8c7a66" },
      { var: "--chart-cadence", light: "#f97316", dark: "#fb923c" },
      { var: "--chart-grade", light: "#6b7280", dark: "#9ca3af" },
      { var: "--chart-stance-time", light: "#0d9488", dark: "#2dd4bf" },
      {
        var: "--chart-vertical-oscillation",
        light: "#db2777",
        dark: "#f472b6",
      },
      { var: "--chart-vertical-ratio", light: "#ca8a04", dark: "#fbbf24" },
      { var: "--chart-step-length", light: "#4f46e5", dark: "#818cf8" },
    ],
  },
];

const cellStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderBottom: "1px solid var(--color-border-tertiary)",
  fontSize: "var(--font-text-xs-size)",
  verticalAlign: "middle",
};

function TokenTable() {
  return (
    <div
      style={{
        fontFamily: "var(--font-sans)",
        padding: "24px",
        color: "var(--color-text-primary)",
      }}
    >
      {allTokens.map(({ category, tokens }) => (
        <div key={category} style={{ marginBottom: "32px" }}>
          <h3
            style={{
              fontSize: "var(--font-heading-sm-size)",
              fontWeight: "var(--font-weight-semibold)",
              marginBottom: "12px",
            }}
          >
            {category}
          </h3>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr
                style={{
                  textAlign: "left",
                  color: "var(--color-text-tertiary)",
                }}
              >
                <th style={cellStyle}>Variable</th>
                <th style={cellStyle}>Light</th>
                <th style={cellStyle}>Dark</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.var}>
                  <td style={cellStyle}>
                    <code>{t.var}</code>
                  </td>
                  <td style={cellStyle}>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "8px",
                      }}
                    >
                      {t.light.startsWith("#") || t.light.startsWith("rgb") ? (
                        <span
                          style={{
                            display: "inline-block",
                            width: 14,
                            height: 14,
                            borderRadius: 2,
                            backgroundColor: t.light,
                            border: "1px solid var(--color-border-secondary)",
                          }}
                        />
                      ) : null}
                      <code>{t.light}</code>
                    </span>
                  </td>
                  <td style={cellStyle}>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "8px",
                      }}
                    >
                      {t.dark.startsWith("#") || t.dark.startsWith("rgb") ? (
                        <span
                          style={{
                            display: "inline-block",
                            width: 14,
                            height: 14,
                            borderRadius: 2,
                            backgroundColor: t.dark,
                            border: "1px solid var(--color-border-secondary)",
                          }}
                        />
                      ) : null}
                      <code>{t.dark}</code>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

const meta = preview.meta({
  title: "Design System/Token Reference",
  component: TokenTable,
});

export const AllTokens = meta.story({});
