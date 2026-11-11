# Patches

Upstream packages with the local patches applied (see `patches/` on `master`).

## pi-auto-continue

- upstream: 0.4.1
- patch: 0001-silent-auto-retry-with-backoff.patch sha256:4ace811304f01d852f8a702b652bc928fb7c56dbf57373cbbefe104201d91bcf
- patch: 0002-session-scoped-waits.patch sha256:f075fab738e4497f1c78d23254bf190798f8d76854b5e027c75036a41c7b1417
- patch: 0003-wait-for-known-reset-and-parse-tilde.patch sha256:94f6b7528e40b613ab28d3ebca159f17b623c7adbcc3f32f468f89983015c10a
- patch: 0004-resume-after-transient-stream-failure.patch sha256:860007f03ec88d5ed434c0ca00000fe9ca72418cdf34b6a94be59261075235f0
- patch: 0005-keep-earlier-armed-wait.patch sha256:8169b7e506e16dd6ae2ed8478fed1a5a106019df3243c1d8b3eea059c8088911
- file: src/index.ts sha256:c210ec762713559b6126e07fdf67cf01f44c8691355e33f66ffbdb6c0c74b7c7
- file: src/pending-store.ts sha256:8895be6c68083eab31cba4e16044551d15b9b8c9ee989096ba5e8d6f62b7cbb8
- file: src/reset-parse.ts sha256:3a25f787ef13a4c99d60f7377911f0197b2786eb0c95850754a24be376407243
- file: src/util.ts sha256:93f5c69709d58183a035a4b6fcc263e37109ee324c33ced725818e199f7e5e49

## pi-better-goal

- upstream: 0.12.2
- patch: 0001-permission-hold-reported-failures.patch sha256:14a3cb7fd3c9d275c1e081adb4845122f55c3f853a5e16424fb9fa947bf6fa2e
- patch: 0002-recover-plain-language-goals.patch sha256:1bbd4fd7b5e41cf940d0baec49b634161c3a4c253ff998e2ec1c91ed8f4f47f3
- patch: 0003-usage-limit-not-no-progress.patch sha256:e468c6fd41acff5724f41537175dd1df22cb542a2a4cf8e1ee2729724abdacc0
- patch: 0004-usage-limit-reset-hint.patch sha256:79a07e7c79a7519bb212e3af43e6915993d4612d4f1dafa7d5f4ae970dbd8b46
- patch: 0005-hold-on-authentication-failure.patch sha256:5af238872651ca950479fb95438814ef212c13e05f2b80571babffabe199c097
- patch: 0006-idle-only-turns-back-off.patch sha256:148887c3dec2651b12e4d516183b87ff56bf86f7cd4896934ffa63c3ec605771
- patch: 0007-release-stale-no-progress-hold.patch sha256:ab5348bb2582e4d6c1d727e6ac61feb36739eb98244ba0297a9218b5011c8134
- patch: 0008-standing-goal-not-completed-by-tool.patch sha256:02ad9f64254ff4296ec870b465d2e5ec3a9c9ec491d32c9a61154cc8238734d3
- patch: 0009-tighten-auth-and-standing-goal-matchers.patch sha256:e980c0e29b2a2afb7a056d91f8e216a619650cb56e985ef2eab14fe79c8620c6
- patch: 0010-keep-text-only-turns-and-hold-semantics.patch sha256:c112114791d0249266000ff26f033087bad96156ca781750659e27042c836003
- file: src/continuation.ts sha256:faee944ff470f05471ad734b5516ba34d2ee8110313a77d909b2f7fe0ae82ddc
- file: src/goal-state.ts sha256:69d370797e3604f70846f423ccb47657ab5139758ec8d89c6ee874b3e15581ab
- file: src/index.ts sha256:80e1c3f12e442bf94e8b65f7f1daff644b7b36367b746842d9cd994178f9b55a
- file: src/permission-hold.ts sha256:d9207f226edad7481731e65b5fbda6e20b559a08d7e0f1f00ccf209981bb02f0
- file: src/preferences.ts sha256:b7db1e79d89613627b71a3cdbe22af5a07c260a973edafec32c340158b35dc5b
- file: src/provider-limit.ts sha256:5d748fce2cde64c203f303f3b54a704d2548fa2090056a336351cf4c77dd1a03
- file: src/settings-page.ts sha256:4775147ad61d08e76f0863bded85d5d8310a39b5a10d33ccdb22de6b52a83697

## pi-better-subagents

- upstream: 0.27.2
- patch: 0001-permission-hold-reported-failures.patch sha256:5d8c10e1cc217a715d2ba334bcb9a66593b170e4bf7a4de66a4cba0e4829ecd6
- patch: 0002-drop-pi-binary-path-check-for-sandbox.patch sha256:0b67a0f957a1f776b9c5e3686a0f4efd9f70b223834dc5843e09413513d1228f
- patch: 0003-readable-bash-failure-summary.patch sha256:85183521283c57b0ce03a7a80cb484b9b265fcb5401152cc71904ea79df09b8f
- patch: 0004-count-fix-loop-failures-per-edit-epoch.patch sha256:1c2ee7e2302255f8ad29970583c17cce6bc9c43c57102d1569647f33b97c9e69
- patch: 0005-preflight-failure-cause-in-exit-summary.patch sha256:004b38c34cc516a8076d71d937c615928e014fc6a17990daa7a1e2a7af0a02e6
- file: finalization.ts sha256:c7ff2a7f72ee94dd8359758e435826749a1ed9b3da3fd31328a8a282a46cdd66
- file: incident-model.ts sha256:b109fb3724fbd33c3957bc61b0842e36cc180d594000ba6b60ed1b4cea353981
- file: shared-failure-observations.ts sha256:695d4b6166edb6f68722556c860a10ad35980465d06f3bfd25cf0197d7d7b02c
- file: task-policy.ts sha256:81ddadec0967289a8408da3d250ab4743bbb0de07304a41acaecee67241ed822
- file: tools.ts sha256:2d98df1baec9f36a9ec3146638c7a631a1816395e83bc40b87f9af133083315d

## pi-loop-monitor

- upstream: 0.2.8
- patch: 0001-no-wake-for-monitor-started.patch sha256:945fa40dc72ce166a9a01d8184a1c57f8e496114ffa560c7f3488489e03c017a
- patch: 0002-unlimited-maxfires-and-quiet-monitor-timeout.patch sha256:c8df19ff74a4fe765673fa82b7ca176efa3043f4ed9121667d6ad50f31e1108a
- patch: 0003-wake-age-note.patch sha256:3f3e0f02dee43c13ecd9566a24b83b267d444192588e43063e6684554ce1b627
- patch: 0004-provider-limit-stand-down.patch sha256:5b563c45a3ad41aa3565202335b045ce43ab75b98da8b2db8bed9de5276e4149
- patch: 0005-hold-queued-wakes-during-provider-limit.patch sha256:1bd85c703bb901cb5ed9335f0552b7fe1bc28bc726cae7797b3bc2e8474ab1ca
- file: dist/index.js sha256:545762ddee205ce48e8bd1f1101c071ea5eab7686cc9a8a2f77a1c0bffa1c08f
- file: dist/runtime/notification-runtime.js sha256:2b201ca1f158872789c3af7657df3ee1417b08d40201d0f73276ea35ca88c43d
- file: dist/tools/loop-tools.js sha256:a5cb492b01c1bf9c1e23fb5c306a5d97ec45839c36c3642eaee43c9453b8cf2c
- file: dist/tools/monitor-tools.js sha256:f5be551003eb9d10cb05c57638d4be97d9a0cdfaf4b4ece89192a97f83d4c6c1

## pi-codex-native

- upstream: 0.3.13
- patch: 0001-terminal-limit-message-from-event-payload.patch sha256:835ea3c8e65081989a0da17c0bd87008ad96cbc110ce80019a87a9bbe3d1b6fb
- patch: 0002-classify-token-revoked-as-authentication.patch sha256:5372f4e1ecd8122efc33b1b742395b8c9804fb99c2ef9a75ac53f63b666e8f33
- patch: 0003-throttling-budget-error-keeps-cause.patch sha256:9d697ae8a4151a00b04332e53a8c92ce88638da980a7df2e55cdc08b4646c9c2
- patch: 0004-skip-doomed-prewarm-and-second-send.patch sha256:87148b6f780b122a03b5e45a34ec6619907a5b1c488f7dc216c3b511adab3a3f
- file: src/provider/diagnostic-failure.ts sha256:6d46741df199ac5c7fdc2ec634b4139067c2907cf27d31799fa2b763b2130cfd
- file: src/provider/stream-events.ts sha256:e4992e87c6e24f2f656eff496a1af5668131e4ac1be6dd880ed448e2bf59abca
- file: src/provider/transport-recovery.ts sha256:e57a4bfb14de81ef7943d1e4b3c89c8c7b32a36d4cc605cc90014dbf48180175
