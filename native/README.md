# Native search engine

Windows builds vendor the complete source of [goz](https://github.com/mustafaahci/goz)
under `native/goz/`. It is an independent MIT-licensed NTFS filename search
engine, not a copy of Voidtools Everything. The upstream copyright and license
are preserved in `native/goz/LICENSE`.

The two Windows binaries are built from this source in CI:

- `goz.exe`: unelevated JSON search client.
- `gozd.exe`: elevated NTFS MFT/USN Journal indexing daemon.

The Electron adapter prefers `goz.exe` when its `gozd` service is reachable,
then falls back to `es.exe` when Everything is installed, and finally to the
local index. macOS does not run this Windows-only backend; it uses Spotlight
and the local index instead.

The daemon must be installed or running with administrator permission on the
Windows machine before the open-source backend can answer whole-PC queries:

```powershell
gozd.exe install
goz.exe --status
```

The app never stores Windows credentials and does not silently install an
elevated service.
