# Changelog

## [2.8.0](https://github.com/ljcl/intervals-mcp/compare/v2.7.0...v2.8.0) (2026-10-10)


### Features

* output schemas that survive a deploy, athlete pace zones in cadence trends ([#181](https://github.com/ljcl/intervals-mcp/issues/181)) ([788ebbd](https://github.com/ljcl/intervals-mcp/commit/788ebbd45aff3cf02ff887f6a0f991790ac41db9))

## [2.7.0](https://github.com/ljcl/intervals-mcp/compare/v2.6.0...v2.7.0) (2026-10-10)


### Features

* weather and per-km drift in run comparisons, data in every view, labelled moving times ([#179](https://github.com/ljcl/intervals-mcp/issues/179)) ([37c040d](https://github.com/ljcl/intervals-mcp/commit/37c040dec1ac83d670ce19d70a0dee9f1cfc0b92))

## [2.6.0](https://github.com/ljcl/intervals-mcp/compare/v2.5.1...v2.6.0) (2026-10-10)


### Features

* give view-* tools' text twin to clients that cannot show MCP Apps ([#176](https://github.com/ljcl/intervals-mcp/issues/176)) ([d2829e3](https://github.com/ljcl/intervals-mcp/commit/d2829e340fccc103740693135a8218574649952b))


### Bug Fixes

* load MCP App charts in claude.ai by serving 2025-era requests read-only ([#178](https://github.com/ljcl/intervals-mcp/issues/178)) ([2cd5ee3](https://github.com/ljcl/intervals-mcp/commit/2cd5ee39df2a624ea6d88c6ab5d2a511421ecdb5))

## [2.5.1](https://github.com/ljcl/intervals-mcp/compare/v2.5.0...v2.5.1) (2026-10-09)


### Bug Fixes

* **deps:** bump MCP SDK to server/client 2.3.1 and ext-apps 2.0.3 ([#170](https://github.com/ljcl/intervals-mcp/issues/170)) ([348885e](https://github.com/ljcl/intervals-mcp/commit/348885e4803aea401f5359c138cf5c61bb0c0604))

## [2.5.0](https://github.com/ljcl/intervals-mcp/compare/v2.4.0...v2.5.0) (2026-10-09)


### Features

* check config at startup, follow the athlete's time zone, stop cancelled calls, and log who called and why (epic [#119](https://github.com/ljcl/intervals-mcp/issues/119)) ([#165](https://github.com/ljcl/intervals-mcp/issues/165)) ([a524918](https://github.com/ljcl/intervals-mcp/commit/a524918bcd42f753b779488dfb3e637d9a453c12)), closes [#56](https://github.com/ljcl/intervals-mcp/issues/56) [#69](https://github.com/ljcl/intervals-mcp/issues/69) [#70](https://github.com/ljcl/intervals-mcp/issues/70) [#71](https://github.com/ljcl/intervals-mcp/issues/71)

## [2.4.0](https://github.com/ljcl/intervals-mcp/compare/v2.3.0...v2.4.0) (2026-10-09)


### Features

* answer more athlete questions (epic [#117](https://github.com/ljcl/intervals-mcp/issues/117)) ([#166](https://github.com/ljcl/intervals-mcp/issues/166)) ([271c90e](https://github.com/ljcl/intervals-mcp/commit/271c90ec7e27557c31e14327324c89e63bc09d91))
* **training-load:** switch between whole-body and run-only scope in the card ([#160](https://github.com/ljcl/intervals-mcp/issues/160)) ([5391601](https://github.com/ljcl/intervals-mcp/commit/53916010e58ddf876b9d7edf48eca6b83e35e2d5))


### Bug Fixes

* **cadence-trends:** day-aligned trend ticks and a time-based rolling average ([#159](https://github.com/ljcl/intervals-mcp/issues/159)) ([d9b426d](https://github.com/ljcl/intervals-mcp/commit/d9b426dad006bd5bd5af235f1d86eafe3b88cc60))
* get-best-efforts reads oldest, newest and days as its window, and replies name ignored arguments ([#155](https://github.com/ljcl/intervals-mcp/issues/155)) ([e38625d](https://github.com/ljcl/intervals-mcp/commit/e38625d1068f2270b88c64ba88b43d00629dc7f5))
* keep server instructions under 1,800 characters for every time zone ([#154](https://github.com/ljcl/intervals-mcp/issues/154)) ([23a33d0](https://github.com/ljcl/intervals-mcp/commit/23a33d0630282c8a91ba5b52b756ef80417721fc))
* **route-map:** keep a set-viewport frame when the basemap fails before load ([#158](https://github.com/ljcl/intervals-mcp/issues/158)) ([95add8f](https://github.com/ljcl/intervals-mcp/commit/95add8f2f95917e2d8cf4f10c73ba0569fca11be))

## [2.3.0](https://github.com/ljcl/intervals-mcp/compare/v2.2.0...v2.3.0) (2026-10-05)


### Features

* accept id "latest" for the most recent run ([#139](https://github.com/ljcl/intervals-mcp/issues/139)) ([103437e](https://github.com/ljcl/intervals-mcp/commit/103437ee0f37aeb7b75f6643c502e3f532574b5c))
* fix the two prompts, add race-readiness, run-debrief and injury-check, and complete prompt arguments ([#137](https://github.com/ljcl/intervals-mcp/issues/137)) ([8d15dcf](https://github.com/ljcl/intervals-mcp/commit/8d15dcf126571c466831217ddf963ff849ebc09b))
* list-activities finds every run type, searches all history, and reports tags and race ([#138](https://github.com/ljcl/intervals-mcp/issues/138)) ([f70513b](https://github.com/ljcl/intervals-mcp/commit/f70513b67e812315b45d04d3758bc1a1133d9b19))
* MCP Apps show the truth and can be driven by the model (epic [#115](https://github.com/ljcl/intervals-mcp/issues/115)) ([#142](https://github.com/ljcl/intervals-mcp/issues/142)) ([f0c42dc](https://github.com/ljcl/intervals-mcp/commit/f0c42dc460a96ffedbfff3bd0e8060ef8a026a55))
* one naming scheme for tool inputs, and pin id "latest" in the apps ([#150](https://github.com/ljcl/intervals-mcp/issues/150)) ([8cd17d6](https://github.com/ljcl/intervals-mcp/commit/8cd17d662a28e3bf5a922f4fb905aa41670747fd))


### Bug Fixes

* accept common spellings of shared inputs, and name the unknown key when a call fails ([#136](https://github.com/ljcl/intervals-mcp/issues/136)) ([83f2627](https://github.com/ljcl/intervals-mcp/commit/83f2627cc583a1c185b27153a47e459119ff8f0f))
* hold every tool response to a size budget, and point truncated text at the call that returns the rest ([#134](https://github.com/ljcl/intervals-mcp/issues/134)) ([27f19a1](https://github.com/ljcl/intervals-mcp/commit/27f19a1c4b3306b9c62e5c244238e54b29fda65c))

## [2.2.0](https://github.com/ljcl/intervals-mcp/compare/v2.1.1...v2.2.0) (2026-10-05)


### Features

* analysis numbers you can trust (epic [#114](https://github.com/ljcl/intervals-mcp/issues/114)) ([#125](https://github.com/ljcl/intervals-mcp/issues/125)) ([8f83650](https://github.com/ljcl/intervals-mcp/commit/8f83650ebb516a2e0b8fb7d8f594e2903762fe23))


### Bug Fixes

* :latest image tag tracks the newest release, not unreleased main ([#120](https://github.com/ljcl/intervals-mcp/issues/120)) ([9d0a5b9](https://github.com/ljcl/intervals-mcp/commit/9d0a5b966e555a6a92d9d75af580962932509150))
* handle Cloudflare errors, body timeouts, quiet progress streams and shutdown drain ([#110](https://github.com/ljcl/intervals-mcp/issues/110)) ([7d56bd1](https://github.com/ljcl/intervals-mcp/commit/7d56bd1ae97e4b382bd71180f5e3cacdfb863f42))
* ship the server as one bundle, without the MCP Apps' build-time dependencies ([#122](https://github.com/ljcl/intervals-mcp/issues/122)) ([6444867](https://github.com/ljcl/intervals-mcp/commit/6444867be1285a12843e9899c7a81f2a45f751ad))

## [2.1.1](https://github.com/ljcl/intervals-mcp/compare/v2.1.0...v2.1.1) (2026-09-27)


### Bug Fixes

* training load counts a layoff that is still going on ([#109](https://github.com/ljcl/intervals-mcp/issues/109)) ([8d93dd8](https://github.com/ljcl/intervals-mcp/commit/8d93dd8477abebeaa37cab7458f7516840eef855))
* training load counts whole weeks, and the chart and text tool give the same warnings ([#107](https://github.com/ljcl/intervals-mcp/issues/107)) ([7649df2](https://github.com/ljcl/intervals-mcp/commit/7649df215a38317cedeb6f07db9c83bf55576916))

## [2.1.0](https://github.com/ljcl/intervals-mcp/compare/v2.0.0...v2.1.0) (2026-09-26)


### Features

* send server instructions and display titles to every host ([#96](https://github.com/ljcl/intervals-mcp/issues/96)) ([d7c54fc](https://github.com/ljcl/intervals-mcp/commit/d7c54fcf1d645863bada8b98deb636d77e82f824))


### Bug Fixes

* activity-zones app shows the local day and why zones are missing ([#102](https://github.com/ljcl/intervals-mcp/issues/102)) ([d6bd178](https://github.com/ljcl/intervals-mcp/commit/d6bd178b827ced388f1c3758911a6704a07dec54))
* adding a note no longer silently erases an activity's description ([#98](https://github.com/ljcl/intervals-mcp/issues/98)) ([ab5a873](https://github.com/ljcl/intervals-mcp/commit/ab5a8730250a068d470c8cab4d7d41129cb2c2ec))
* clearer feel, dynamics, time, HR and error text in tool output ([#104](https://github.com/ljcl/intervals-mcp/issues/104)) ([a5ba837](https://github.com/ljcl/intervals-mcp/commit/a5ba8377d4e7b300ed83f48413e9ee45de9ff8ad))
* compare-activities efficiency is speed per heartbeat, not pace divided by heart rate ([#94](https://github.com/ljcl/intervals-mcp/issues/94)) ([7655601](https://github.com/ljcl/intervals-mcp/commit/765560132a250600341de86dcff1ed06cb57fa72))
* fitness trend shows an error and retry when a scope fails to load ([#103](https://github.com/ljcl/intervals-mcp/issues/103)) ([92ad8cc](https://github.com/ljcl/intervals-mcp/commit/92ad8cc2022e31f4c8a8efd1138fa63bf9b40401))
* fullscreen exit button and mobile layout survive host updates ([#100](https://github.com/ljcl/intervals-mcp/issues/100)) ([401b6b6](https://github.com/ljcl/intervals-mcp/commit/401b6b601776750e96c0231bdb94b4d24d487dd3))
* get-race-prediction counts each run once, not each pace-curve point ([#92](https://github.com/ljcl/intervals-mcp/issues/92)) ([6d87905](https://github.com/ljcl/intervals-mcp/commit/6d879057cff48a1a8de587951a79f69ad6fd0ee4))
* get-wellness shows rMSSD HRV and no longer assumes an Apple Watch ([#97](https://github.com/ljcl/intervals-mcp/issues/97)) ([6c96e79](https://github.com/ljcl/intervals-mcp/commit/6c96e7920d4b86d42ad1bbad55822560f4079674))
* heart-rate dropouts show as gaps, not 0 bpm, in streams and charts ([#101](https://github.com/ljcl/intervals-mcp/issues/101)) ([09ed5a3](https://github.com/ljcl/intervals-mcp/commit/09ed5a3aa1770bad42a8b1450a290019b45f6edc))
* tool descriptions fit Claude Code's limit and name the tool to use instead ([#95](https://github.com/ljcl/intervals-mcp/issues/95)) ([7d03e91](https://github.com/ljcl/intervals-mcp/commit/7d03e911cf2a1b017d9a5a1df6bcdd9f2cb12234))

## [2.0.0](https://github.com/ljcl/intervals-mcp/compare/v1.0.1...v2.0.0) (2026-09-26)


### ⚠ BREAKING CHANGES

* serve only the 2026-07-28 stateless MCP revision ([#36](https://github.com/ljcl/intervals-mcp/issues/36))

### Code Refactoring

* serve only the 2026-07-28 stateless MCP revision ([#36](https://github.com/ljcl/intervals-mcp/issues/36)) ([bcd3051](https://github.com/ljcl/intervals-mcp/commit/bcd3051b0316e71d239dc5bbe7c2529420fc8ae2))

## [1.0.1](https://github.com/ljcl/intervals-mcp/compare/v1.0.0...v1.0.1) (2026-09-26)


### Bug Fixes

* feel scale in update-activity is verified, not assumed ([#34](https://github.com/ljcl/intervals-mcp/issues/34)) ([4f8ba0e](https://github.com/ljcl/intervals-mcp/commit/4f8ba0e2c5cd0417eeab7d8f03756ca85f1e8d9d))

## [1.0.0](https://github.com/ljcl/intervals-mcp/compare/v0.2.0...v1.0.0) (2026-09-26)


### Bug Fixes

* **deps:** ext-apps 2.0, Bun 1.4.2, dotenv 18 and minor updates ([#25](https://github.com/ljcl/intervals-mcp/issues/25)) ([e38e483](https://github.com/ljcl/intervals-mcp/commit/e38e483d09c0852f2d14c4d7b81e3822e23ed61e))
* **docker:** keep tests, fixtures and stories out of the image ([#28](https://github.com/ljcl/intervals-mcp/issues/28)) ([a22e140](https://github.com/ljcl/intervals-mcp/commit/a22e14071460e416cb5cec36bfbd4e3d8df17e35))
* plain punctuation in tool output and descriptions ([#30](https://github.com/ljcl/intervals-mcp/issues/30)) ([af2b9b5](https://github.com/ljcl/intervals-mcp/commit/af2b9b582bce8c8d271c1789bb6a0fd218ee6586))

## [0.2.0](https://github.com/ljcl/intervals-mcp/compare/v0.1.0...v0.2.0) (2026-09-25)


### ⚠ BREAKING CHANGES

* MCP Apps on intervals.icu, dynamics overlays, fitness scope toggle, Strava client removed ([#23](https://github.com/ljcl/intervals-mcp/issues/23))
* port analysis, load, fitness and write tools to intervals.icu ([#21](https://github.com/ljcl/intervals-mcp/issues/21))
* repurpose as intervals-mcp and remove Strava auth, segments and routes ([#19](https://github.com/ljcl/intervals-mcp/issues/19))

### Features

* add intervals.icu client and core read tools ([#20](https://github.com/ljcl/intervals-mcp/issues/20)) ([b342cbe](https://github.com/ljcl/intervals-mcp/commit/b342cbec5fe47d7200702d628eda0de6d8365dff))
* MCP Apps on intervals.icu, dynamics overlays, fitness scope toggle, Strava client removed ([#23](https://github.com/ljcl/intervals-mcp/issues/23)) ([182e325](https://github.com/ljcl/intervals-mcp/commit/182e32514935b2c003d25ac7e06d4274f18c9a18))
* port analysis, load, fitness and write tools to intervals.icu ([#21](https://github.com/ljcl/intervals-mcp/issues/21)) ([584e613](https://github.com/ljcl/intervals-mcp/commit/584e613997ef69f206388acb39fabcd1f4468445))


### Code Refactoring

* repurpose as intervals-mcp and remove Strava auth, segments and routes ([#19](https://github.com/ljcl/intervals-mcp/issues/19)) ([ddd21e9](https://github.com/ljcl/intervals-mcp/commit/ddd21e9a1e3a65292ced230f995d501248c1894e))

## Changelog

intervals-mcp continues from [strava-mcp](https://github.com/ljcl/strava-mcp) 3.0.0. Earlier history lives in that repository's CHANGELOG.
