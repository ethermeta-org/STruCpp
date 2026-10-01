# Library Namespace Support

Library namespaces follow CODESYS: a bare name resolves when it is unique,
`Namespace.Name` always resolves, and a cross-library bare name is a compile
error that names both namespaces and both library names. This is Option A
from the original design (one C++ namespace per library, `using namespace`
only when nothing in that library clashes).

## Implemented

| Behavior | Where |
|---|---|
| Each library symbol is stamped `sourceNamespace` and `sourceLibrary` | `src/library/library-loader.ts` `defineLibrarySymbol` |
| Bare lookup fails when the name is ambiguous; `NS.NAME` still resolves | `src/semantic/symbol-table.ts` `lookupLibrarySymbol` |
| Diagnostic lists both sides: `'MC.MC_POWER' (library 'mc') or 'OTHER.MC_POWER' (library 'other')` | `src/semantic/symbol-table.ts` `ambiguousQualifyText`; `src/semantic/analyzer.ts` (`Ambiguous function` / `Ambiguous type` / `Ambiguous variable`) |
| Same library registered again keeps the first definition | `defineLibrarySymbol` (same namespace and same library name) |
| Different library, same namespace: registration throws `DuplicateSymbolError` (qualification cannot tell them apart) | `defineLibrarySymbol` |
| Builtin elementary names (`TIME`, …) stay owned by the compiler. A library symbol with the same bare name is not a clash | `defineLibrarySymbol` when the existing symbol has no `sourceNamespace` |
| C++ `namespace NS { … }` plus `using namespace NS` when no emitted name clashes; otherwise `using NS::Name` only for the unambiguous names | `src/backend/codegen.ts` `libraryCppNamespace`, the header and cpp wraps that call it, `emitLibraryUsingDirectives` |

Product libraries:

| Library | `library.json` `namespace` | C++ namespace |
|---|---|---|
| `mc` | `MC` (`runtime/plc/libs/mc/library.json`) | `MC`, including when `isBuiltin` is set. `libraryCppNamespace` does not treat `isBuiltin` as flat |
| `ethercat` | `ETC` (`runtime/plc/libs/ethercat/library.json`) | `ETC` |
| `iec-stdlib` | `strucpp` (`src/library/builtin-stdlib.ts`) | flat, inside `namespace strucpp` |
| `iec-standard-fb` | whatever the manifest says | flat. `libraryCppNamespace` returns on that library name before it reads `namespace` |

The C ABI the runtime `dlsym`s is not inside those namespaces. `strucpp_get_config` and `strucpp_advance_time` are `extern "C"` in `runtime/plc/strucpp/runtime_v4_entry.cpp`. `strucpp_debug_read` / `strucpp_debug_write` are `extern "C"` in `src/runtime/include/debug_dispatch.hpp` under `STRUCPP_V4_DEBUG_EXPORTS_DEFINE`. `runtime/plc/tests/check_ns_so_symbols.sh` runs `nm -D --defined-only` on `libplc_strucpp.so` after a compile that emitted `namespace MC`.

## Limits

- `iec-stdlib` and `iec-standard-fb` stay flat. They are not moved into a user namespace.
- A namespace that is empty, `strucpp`, or not a C identifier is not wrapped.
- Two libraries that pick the same namespace and the same symbol fail at registration, including when a builtin already owns the bare name (`TIME`). The ST diagnostic path is only for different namespaces.
- A bare library global that clashes is `Ambiguous variable`, listing both namespaces and both library names. In a statement, `NS.Name` is rewritten to `NS::Name` (`analyzer.ts` `rewriteQualifiedLibraryVariable`) and tree-shake selects that library's chunk. A declared instance wins over a library symbol with the same spelling (`pwr.Method` stays a method call). Flat libraries (`strucpp`, `iec-standard-fb`) emit a bare C++ name for a qualified ST type. `VAR` initializers are not rewritten. `EXTENDS` / `IMPLEMENTS` still take a single identifier. Same-namespace registration throws `DuplicateSymbolError`, which `compile()` reports as a compile error.
- Studio does not surface the clash text. That stays in studio-v2.
- The product `.stlib` ZIP layout is unchanged.
- Library function blocks are not renamed to avoid a clash.

## Tests

`tests/library/library-namespaces.test.ts` covers bare unique use, `MC.MC_Power` and `OTHER.MC_Power` after a clash, the clash diagnostic (both namespaces and both library names), qualified lookup kept on a second register, same-library re-register, same-namespace rejection, `using namespace` vs a blanket using omitted on clash, and the `iec-standard-fb` flat exception.
