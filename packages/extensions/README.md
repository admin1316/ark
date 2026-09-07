# extensions/ — the agent modifies its own runtime

English | [中文](README.zh.md)

Model-facing tools over the live Cordis runtime the agent itself runs inside: inspect the loaded plugins and service API, define and run model-written dynamic packages, and retract them again — plus the restricted repository Plugin runtime. The subsystem is Host-only in the shipped product; the historical browser half is retired. Design home: [the toolset Agent Note](../../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md).

| Package | Role | ctx key |
|---|---|---|
| [`tool-cordis/`](tool-cordis/README.md) | Model-facing runtime inspection and dynamic-package tools | registers on `ctx.tools` |
| [`cordis-host-runner/`](cordis-host-runner/README.md) | Definition registry, the `node:vm` sandbox for host halves, and the request-run round trip | provides `ctx.dynamicCordisRunner` |
