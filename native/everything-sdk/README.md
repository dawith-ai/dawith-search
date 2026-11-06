# Voidtools Everything SDK IPC bridge

This directory contains the IPC wrapper source used by the official Voidtools
Everything SDK download. The SDK header and C wrapper carry the MIT notice from
Voidtools/David Carpenter; those notices are preserved in the imported files.

`everything-ipc.cpp` is Dawith's small JSON command-line bridge. It calls the
SDK functions `Everything_SetSearchW`, `Everything_QueryW`,
`Everything_GetResultFullPathNameW`, `Everything_GetResultSize`, and
`Everything_GetResultDateModified`. It does not copy or link the proprietary
Everything search engine. The Windows user must have the normal Everything
client running because the official SDK is an IPC client and cannot work by
itself.

The official `Everything64.dll` is not redistributed here: the official SDK
download page does not state a separate redistribution grant for that binary.
The bridge is built from the SDK's source IPC wrapper instead, which keeps the
backend auditable and avoids an unlicensed binary bundle. If a future release
obtains explicit redistribution permission, the helper can be switched to the
DLL/Lib variant without changing the Dawith search contract.
