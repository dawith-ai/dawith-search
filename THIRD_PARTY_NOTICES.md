# Third-party notices

## goz

Windows NTFS filename indexing is provided by the vendored `native/goz` project.
It is an independent implementation and is licensed under the MIT License.
Its copyright and license text are preserved in [native/goz/LICENSE](native/goz/LICENSE).

## Voidtools Everything SDK

The optional `everything-ipc.exe` helper is a small bridge built from the
Voidtools SDK source included under `native/everything-sdk`. It communicates
with an already-installed Everything process over IPC; the Everything desktop
application, database, UI, and proprietary runtime are not bundled by this
project. The SDK source notice is preserved in
[native/everything-sdk/LICENSE](native/everything-sdk/LICENSE).

The application must not copy or redistribute the user's installed
`Everything.exe`. If the SDK helper is unavailable, the app uses `goz` or its
own local fallback index.
