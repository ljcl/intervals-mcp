import {
  GRID_DASHARRAY,
  getChartTokens,
  MOBILE_BREAKPOINT_PX,
} from "@intervals-mcp/design-system";
import preview from "@intervals-mcp/design-system/preview";

const cellStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderBottom: "1px solid var(--color-border-tertiary)",
  fontSize: "var(--font-text-xs-size)",
  verticalAlign: "middle",
  textAlign: "left",
};

function ChartTokensTable() {
  const desktop = getChartTokens("desktop");
  const mobile = getChartTokens("mobile");
  const keys = Object.keys(desktop) as (keyof typeof desktop)[];

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
          marginBottom: "12px",
        }}
      >
        getChartTokens(mode)
      </h3>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ color: "var(--color-text-tertiary)" }}>
            <th style={cellStyle}>Token</th>
            <th style={cellStyle}>Desktop</th>
            <th style={cellStyle}>Mobile</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k}>
              <td style={cellStyle}>
                <code>{k}</code>
              </td>
              <td style={cellStyle}>
                <code>{String(desktop[k])}</code>
              </td>
              <td style={cellStyle}>
                <code>{String(mobile[k])}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3
        style={{
          fontSize: "var(--font-heading-sm-size)",
          fontWeight: "var(--font-weight-semibold)",
          margin: "32px 0 12px",
        }}
      >
        Constants
      </h3>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          <tr>
            <td style={cellStyle}>
              <code>GRID_DASHARRAY</code>
            </td>
            <td style={cellStyle}>
              <code>"{GRID_DASHARRAY}"</code>
            </td>
          </tr>
          <tr>
            <td style={cellStyle}>
              <code>MOBILE_BREAKPOINT_PX</code>
            </td>
            <td style={cellStyle}>
              <code>{MOBILE_BREAKPOINT_PX}</code>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

const meta = preview.meta({
  title: "Design System/Chart Tokens",
  component: ChartTokensTable,
});

export const Reference = meta.story({});
