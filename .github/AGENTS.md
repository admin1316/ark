# AGENTS.md — GitHub Actions

Run jobs on Windows runners (`windows-*` labels) under native `pwsh`. The pull-request `windows` job is the exception: it runs Windows Node under Wine on hosted Linux and blocks `all checks passed`; `windows-native` reports independently on `windows-2025`. Required jobs use standard GitHub-hosted runners. The `macos-native` job builds and runs Ark's native contracts and participates in the required verdict; it does not substitute for local candidate GUI acceptance.

`ci.yml` is pull-request-only. Main-branch serial checks and the Wine cache seeder remain in `ci-master.yml`, which listens to pushes on `main`. Keep push-only jobs out of PR check panels. The two manual larger-runner benchmarks are optional infrastructure experiments and require their explicitly configured runner pools; they are not release prerequisites. Never remove a failed or cancelled required job from the aggregate verdict to make it pass.
