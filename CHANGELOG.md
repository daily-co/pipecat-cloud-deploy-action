# Changelog

## [2.1.2](https://github.com/daily-co/pipecat-cloud-deploy-action/compare/v2.1.1...v2.1.2) (2026-08-12)


### Bug Fixes

* address npm audit vulnerabilities (fast-uri, js-yaml, undici) ([#17](https://github.com/daily-co/pipecat-cloud-deploy-action/issues/17)) ([6e457e0](https://github.com/daily-co/pipecat-cloud-deploy-action/commit/6e457e0bf6d270864415057fb07041d02d53f06a))

## [2.1.1](https://github.com/daily-co/pipecat-cloud-deploy-action/compare/v2.1.0...v2.1.1) (2026-06-26)


### Bug Fixes

* update @actions/http-client to v4 and resolve undici vulnerabilities ([#16](https://github.com/daily-co/pipecat-cloud-deploy-action/issues/16)) ([9e4bd27](https://github.com/daily-co/pipecat-cloud-deploy-action/commit/9e4bd27fd714254e8559987cd12b00ea4c1fb4a3))
* update js-yaml to resolve security vulnerability ([#14](https://github.com/daily-co/pipecat-cloud-deploy-action/issues/14)) ([7a44bd7](https://github.com/daily-co/pipecat-cloud-deploy-action/commit/7a44bd71a1dd784e31b9c175209eb27df3d148f0))

## [2.1.0](https://github.com/daily-co/pipecat-cloud-deploy-action/compare/v2.0.3...v2.1.0) (2026-05-21)


### Features

* add max-session-duration and krisp-viva inputs ([#13](https://github.com/daily-co/pipecat-cloud-deploy-action/issues/13)) ([96ae51c](https://github.com/daily-co/pipecat-cloud-deploy-action/commit/96ae51c728162f7d9e74f5e5ecb16994272716ad))


### Bug Fixes

* resolve fast-uri security vulnerability ([#11](https://github.com/daily-co/pipecat-cloud-deploy-action/issues/11)) ([acc59b9](https://github.com/daily-co/pipecat-cloud-deploy-action/commit/acc59b9048f9f13152b35d495c0e885c8a8140b1))

## [2.0.3](https://github.com/daily-co/pipecat-cloud-deploy-action/compare/v2.0.2...v2.0.3) (2026-04-26)


### Bug Fixes

* exclude component name from release-please tags ([#8](https://github.com/daily-co/pipecat-cloud-deploy-action/issues/8)) ([5cb82ad](https://github.com/daily-co/pipecat-cloud-deploy-action/commit/5cb82adf27816faa70f71ef8f5c2a316751b000b))
* patch undici vulnerabilities via npm overrides ([#10](https://github.com/daily-co/pipecat-cloud-deploy-action/issues/10)) ([178ba38](https://github.com/daily-co/pipecat-cloud-deploy-action/commit/178ba383e0e1bef2dbc0e10d0edb0cca1d477f58))

## [2.0.2](https://github.com/daily-co/pipecat-cloud-deploy-action/compare/pipecat-cloud-deploy-actionv2.0.1...pipecat-cloud-deploy-actionv2.0.2) (2026-04-01)


### Bug Fixes

* filter client-side cache lookup by dockerfilePath ([#4](https://github.com/daily-co/pipecat-cloud-deploy-action/issues/4)) ([b82f505](https://github.com/daily-co/pipecat-cloud-deploy-action/commit/b82f5053a3a992de89878781c4662da6ef33051b))
* lint PR title instead of individual commits for squash merge compatibility ([#6](https://github.com/daily-co/pipecat-cloud-deploy-action/issues/6)) ([f9cd73e](https://github.com/daily-co/pipecat-cloud-deploy-action/commit/f9cd73e205999041b160913208069b08f32ca799))


### Miscellaneous

* set up release-please, commitlint, and major tag workflow ([#5](https://github.com/daily-co/pipecat-cloud-deploy-action/issues/5)) ([fab1eb8](https://github.com/daily-co/pipecat-cloud-deploy-action/commit/fab1eb88e0fa13cef0dfc9590dbbe29f4cc3ce3d))
