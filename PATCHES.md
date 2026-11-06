# Patches

Upstream packages with the local patches applied (see `patches/` on `master`).

## pi-auto-continue

- upstream: 0.4.1
- patch: 0001-silent-auto-retry-with-backoff.patch sha256:4ace811304f01d852f8a702b652bc928fb7c56dbf57373cbbefe104201d91bcf
- patch: 0002-session-scoped-waits.patch sha256:f075fab738e4497f1c78d23254bf190798f8d76854b5e027c75036a41c7b1417
- patch: 0003-wait-for-known-reset-and-parse-tilde.patch sha256:94f6b7528e40b613ab28d3ebca159f17b623c7adbcc3f32f468f89983015c10a
- patch: 0004-resume-after-transient-stream-failure.patch sha256:860007f03ec88d5ed434c0ca00000fe9ca72418cdf34b6a94be59261075235f0
- file: src/index.ts sha256:31bc55bd7d488c5831626025fea4f6b00e345475f124c78cefa928c51e7f63e0
- file: src/pending-store.ts sha256:8895be6c68083eab31cba4e16044551d15b9b8c9ee989096ba5e8d6f62b7cbb8
- file: src/reset-parse.ts sha256:3a25f787ef13a4c99d60f7377911f0197b2786eb0c95850754a24be376407243
- file: src/util.ts sha256:93f5c69709d58183a035a4b6fcc263e37109ee324c33ced725818e199f7e5e49

## pi-better-goal

- upstream: 0.11.0
- patch: 0001-permission-hold-reported-failures.patch sha256:d71127d197ccd77e691e742ae791a3e5fbedc4170c752bee6d310d726a87d184
- patch: 0002-recover-plain-language-goals.patch sha256:6ed7a7885851bc4b97106142d28709be20af3ec9c430b61bd4125ae58e84dc75
- patch: 0003-usage-limit-not-no-progress.patch sha256:9590f4c6c6f6950220185e9c18a5ea54b357cbeedada7e3af3a5347eace02fcd
- file: src/index.ts sha256:67681b24398ec1446c62739ffc72c3c73e19c92bfd363aebb1d434e0959c91e4
- file: src/permission-hold.ts sha256:d9207f226edad7481731e65b5fbda6e20b559a08d7e0f1f00ccf209981bb02f0
- file: src/preferences.ts sha256:b7db1e79d89613627b71a3cdbe22af5a07c260a973edafec32c340158b35dc5b
- file: src/settings-page.ts sha256:4775147ad61d08e76f0863bded85d5d8310a39b5a10d33ccdb22de6b52a83697

## pi-better-subagents

- upstream: 0.26.2
- patch: 0001-permission-hold-reported-failures.patch sha256:5d8c10e1cc217a715d2ba334bcb9a66593b170e4bf7a4de66a4cba0e4829ecd6
- file: shared-failure-observations.ts sha256:695d4b6166edb6f68722556c860a10ad35980465d06f3bfd25cf0197d7d7b02c
- file: tools.ts sha256:2d98df1baec9f36a9ec3146638c7a631a1816395e83bc40b87f9af133083315d
