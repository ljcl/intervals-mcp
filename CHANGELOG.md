# Changelog

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
