---
description: "This group contains prototypes and internal-only Cordis plugins that use the repository's real runtime without joining an official release."
kind: "package-group"
---

# experimental/ — private experimental packages

English | [中文](README.zh.md)

This group contains prototypes and internal-only Cordis plugins that use the repository's real runtime without joining an official release. Its packages are private, carry no stability or support promise, and retain the same engineering, security, documentation, lifecycle, testing, and snapshot requirements as release packages.

The [subtree rules](AGENTS.md) define dependency isolation, release exclusion, and promotion.

The retained prototypes are [Agent Team](agent-team/README.md), its [tool](tool-agent-team/README.md) and [profile](agent-team-profile/README.md), and the [Host Inspector](inspector/README.md). Their package READMEs define their contracts; the [runtime extensions reference](../../docs/subsystems/extensions.md) describes shared inspection and lifecycle concepts.
