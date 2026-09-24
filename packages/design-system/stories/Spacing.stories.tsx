import preview from "@intervals-mcp/design-system/preview";

const SPACING_STEPS = [
  { name: "--space-0-5", value: 2 },
  { name: "--space-1", value: 4 },
  { name: "--space-1-5", value: 6 },
  { name: "--space-2", value: 8 },
  { name: "--space-3", value: 12 },
  { name: "--space-4", value: 16 },
  { name: "--space-6", value: 24 },
];

function Box({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "var(--space-3)",
        background: "var(--color-background-secondary)",
        border: "1px solid var(--color-border-tertiary)",
        borderRadius: "var(--border-radius-md)",
        fontSize: "var(--font-text-sm-size)",
      }}
    >
      {children}
    </div>
  );
}

function SpacingScale() {
  return (
    <div
      style={{
        padding: "24px",
        fontFamily: "var(--font-sans)",
        color: "var(--color-text-primary)",
      }}
    >
      <h3
        style={{
          fontSize: "var(--font-heading-sm-size)",
          fontWeight: "var(--font-weight-semibold)",
          marginBottom: "16px",
        }}
      >
        Ladder
      </h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {SPACING_STEPS.map((step) => (
          <div
            key={step.name}
            style={{ display: "flex", alignItems: "center", gap: 16 }}
          >
            <code style={{ width: 120, fontSize: 12 }}>{step.name}</code>
            <code
              style={{
                width: 48,
                fontSize: 12,
                color: "var(--color-text-tertiary)",
              }}
            >
              {step.value}px
            </code>
            <div
              style={{
                width: step.value,
                height: 24,
                background: "var(--color-background-inverse)",
                borderRadius: "var(--border-radius-sm)",
              }}
            />
          </div>
        ))}
      </div>

      <h3
        style={{
          fontSize: "var(--font-heading-sm-size)",
          fontWeight: "var(--font-weight-semibold)",
          margin: "32px 0 16px",
        }}
      >
        Stack example (gap = --space-3)
      </h3>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-3)",
          maxWidth: 320,
        }}
      >
        <Box>Row one</Box>
        <Box>Row two</Box>
        <Box>Row three</Box>
      </div>

      <h3
        style={{
          fontSize: "var(--font-heading-sm-size)",
          fontWeight: "var(--font-weight-semibold)",
          margin: "32px 0 16px",
        }}
      >
        Inline example (gap = --space-2)
      </h3>
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <Box>A</Box>
        <Box>B</Box>
        <Box>C</Box>
        <Box>D</Box>
      </div>
    </div>
  );
}

const meta = preview.meta({
  title: "Design System/Spacing",
  component: SpacingScale,
});

export const Scale = meta.story({});
