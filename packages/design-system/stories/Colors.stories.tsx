import preview from "@intervals-mcp/design-system/preview";

type ColorToken = { var: string; label: string; note?: string };

const colorTokens: Record<string, ColorToken[]> = {
  Background: [
    { var: "--color-background-primary", label: "Primary" },
    { var: "--color-background-secondary", label: "Secondary" },
    { var: "--color-background-tertiary", label: "Tertiary" },
    { var: "--color-background-inverse", label: "Inverse" },
  ],
  Text: [
    { var: "--color-text-primary", label: "Primary" },
    { var: "--color-text-secondary", label: "Secondary" },
    { var: "--color-text-tertiary", label: "Tertiary" },
    { var: "--color-text-danger", label: "Danger" },
    { var: "--color-text-success", label: "Success" },
    { var: "--color-text-info", label: "Info" },
  ],
  Border: [
    { var: "--color-border-primary", label: "Primary" },
    { var: "--color-border-secondary", label: "Secondary" },
    { var: "--color-border-tertiary", label: "Tertiary" },
  ],
  Chart: [
    { var: "--chart-heartrate", label: "Heart Rate" },
    { var: "--chart-power", label: "Power" },
    { var: "--chart-pace", label: "Pace" },
    { var: "--chart-altitude", label: "Altitude" },
    { var: "--chart-cadence", label: "Cadence" },
    { var: "--chart-grade", label: "Grade" },
    { var: "--chart-stance-time", label: "Ground Contact Time" },
    { var: "--chart-vertical-oscillation", label: "Vertical Oscillation" },
    { var: "--chart-vertical-ratio", label: "Vertical Ratio" },
    { var: "--chart-step-length", label: "Step Length" },
  ],
};

function Swatch({
  variable,
  label,
  note,
}: {
  variable: string;
  label: string;
  note?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        marginBottom: "8px",
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
      <div>
        <div
          style={{
            fontSize: "var(--font-text-sm-size)",
            color: "var(--color-text-primary)",
          }}
        >
          {label}
        </div>
        <code
          style={{
            fontSize: "var(--font-text-xs-size)",
            color: "var(--color-text-tertiary)",
          }}
        >
          {variable}
        </code>
        {note ? (
          <div
            style={{
              fontSize: "var(--font-text-xs-size)",
              color: "var(--color-text-secondary)",
              marginTop: "var(--space-0-5)",
            }}
          >
            {note}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ColorGrid() {
  return (
    <div style={{ fontFamily: "var(--font-sans)", padding: "24px" }}>
      {Object.entries(colorTokens).map(([group, tokens]) => (
        <div key={group} style={{ marginBottom: "32px" }}>
          <h3
            style={{
              fontSize: "var(--font-heading-sm-size)",
              fontWeight: "var(--font-weight-semibold)",
              color: "var(--color-text-primary)",
              marginBottom: "16px",
            }}
          >
            {group}
          </h3>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
              gap: "8px",
            }}
          >
            {tokens.map((t) => (
              <Swatch
                key={t.var}
                variable={t.var}
                label={t.label}
                note={t.note}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const meta = preview.meta({
  title: "Design System/Colors",
  component: ColorGrid,
});

export const Default = meta.story({});
