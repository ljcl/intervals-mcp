export { default } from "@intervals-mcp/design-system/preview";

/**
 * Autodocs: generate a "Docs" page for every component from its stories,
 * JSDoc, and react-docgen prop table. Declared here — a literal
 * in the project's own `.storybook/preview` — because project tags on a
 * re-exported `definePreview` are not picked up by the docs indexer. Storybook
 * merges this named `tags` export with the re-exported preview's config. A
 * component or story opts out with `tags: ["!autodocs"]` (see Compare
 * Activities' interaction-only story).
 */
export const tags = ["autodocs"];
