# Third-party notices

> 본 제품은 한글과컴퓨터의 한글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다. 한글은 한글과컴퓨터의 상표이며, Dawith Search는 한글과컴퓨터와 관계없는 별도 프로젝트입니다.
> (HWP reading is based on Hancom's published HWP file format documents via
> the MIT-licensed OpenHWP project. "Hangul"/"한글" is a trademark of Hancom Inc.)

> Everything is a product and trademark of voidtools. Dawith Search is an
> independent project and is not affiliated with, endorsed by, or sponsored by
> voidtools. Dawith Search does not include or redistribute Everything; it only
> talks to an Everything instance the user installed separately.

The full license texts of the bundled components are installed with the app
in its `licenses` folder (`LICENSE-Everything-SDK.txt`, `LICENSE-goz.txt`,
`THIRD_PARTY_LICENSES-rust.txt`).

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
`Everything.exe`. Since 1.3.0 the app searches its own index by default; the
SDK helper and `goz` are optional components used only when the user sets
`"useEverything": true` in `~/.dawith-search/config.json`.

## Libraries bundled in the Windows/macOS Tauri app

Versions are the ones locked in `src-tauri/Cargo.lock`. Each crate's license
text ships with its source on crates.io or in the linked repository.

| Component | Version | License | Source |
|---|---|---|---|
| Tauri | 2.12.5 | MIT OR Apache-2.0 | https://github.com/tauri-apps/tauri |
| serde | 1.0.229 | MIT OR Apache-2.0 | https://github.com/serde-rs/serde |
| serde_json | 1.0.154 | MIT OR Apache-2.0 | https://github.com/serde-rs/json |
| notify | 6.1.1 | CC0-1.0 | https://github.com/notify-rs/notify |
| rayon | 1.12.0 | MIT OR Apache-2.0 | https://github.com/rayon-rs/rayon |
| OpenHWP `hwp` | git c605402 | MIT | https://github.com/openhwp/openhwp |
| lopdf | 0.34.0 | MIT | https://github.com/J-F-Liu/lopdf |
| image | 0.25.10 | MIT OR Apache-2.0 | https://github.com/image-rs/image |
| ureq | 2.12.1 | MIT OR Apache-2.0 | https://github.com/algesten/ureq |
| sha2 | 0.10.9 | MIT OR Apache-2.0 | https://github.com/RustCrypto/hashes |
| trash | 5.3.0 | MIT | https://github.com/Byron/trash-rs |
| rfd | 0.15.4 | MIT | https://github.com/PolyMeilex/rfd |

Transitive dependencies keep their own licenses; `cargo tree` lists them.

## Libraries in the legacy Electron build (1.1.x)

| Component | Version | License | Source |
|---|---|---|---|
| Electron | 45.0.0 | MIT | https://github.com/electron/electron |
| chokidar | 3.6.0 | MIT | https://github.com/paulmillr/chokidar |
| pdf-lib | 1.17.1 | MIT | https://github.com/Hopding/pdf-lib |
| Express | 4.22.3 | MIT | https://github.com/expressjs/express |
| node-qrcode | 1.5.4 | MIT | https://github.com/soldair/node-qrcode |
