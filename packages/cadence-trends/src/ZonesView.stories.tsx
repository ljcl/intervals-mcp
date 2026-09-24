import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { MobileCardShell } from "@intervals-mcp/ui";
import { mockRuns } from "./__fixtures__/runs";
import { ZonesView } from "./ZonesView";

const meta = preview.meta({ component: ZonesView });

export const Default = meta.story({
  args: { activities: mockRuns },
});

export const Empty = meta.story({
  args: { activities: [] },
});

export const Dark = meta.story({
  globals: darkGlobals,
  args: { activities: mockRuns },
});

export const Mobile = meta.story({
  args: { activities: mockRuns, mode: "mobile" },
  globals: {
    viewport: { value: "claudeIosCard" },
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (StoryFn) => (
      <MobileCardShell>
        <div style={{ height: 260 }}>
          <StoryFn />
        </div>
      </MobileCardShell>
    ),
  ],
});
