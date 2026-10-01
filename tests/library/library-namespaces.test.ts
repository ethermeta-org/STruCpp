import { describe, it, expect } from "vitest";
import { compileStlib } from "../../src/library/library-compiler.js";
import {
  loadLibraryManifest,
  registerLibrarySymbols,
} from "../../src/library/library-loader.js";
import { SymbolTables } from "../../src/semantic/symbol-table.js";
import { compile } from "../../src/index.js";
import { analyzeTestFile } from "../../src/semantic/analyzer.js";
import { parseTestFile } from "../../src/testing/test-parser.js";
import { uppercaseSource } from "../../src/frontend/lexer.js";

function lib(name: string, ns: string, fbName: string) {
  return compileStlib(
    [{
      fileName: `${name}.st`,
      source: `
        FUNCTION_BLOCK ${fbName}
          VAR_INPUT Enable : BOOL; END_VAR
          VAR_OUTPUT Status : BOOL; END_VAR
        END_FUNCTION_BLOCK
      `,
    }],
    { name, version: "1.0.0", namespace: ns },
  );
}

describe("library namespaces", () => {
  it("unqualified MC_Power resolves when only one library exports it", () => {
    const mc = lib("mc", "MC", "MC_Power");
    expect(mc.success).toBe(true);
    const result = compile(
      `PROGRAM P
         VAR pwr : MC_Power; END_VAR
       END_PROGRAM`,
      { libraries: [mc.archive!] },
    );
    expect(result.success).toBe(true);
  });

  it("qualified MC.MC_Power always resolves", () => {
    const mc = lib("mc", "MC", "MC_Power");
    const result = compile(
      `PROGRAM P
         VAR pwr : MC.MC_Power; END_VAR
       END_PROGRAM`,
      { libraries: [mc.archive] },
    );
    expect(result.success).toBe(true);
  });

  it("bare name is an error when two libraries export it", () => {
    const a = lib("mc", "MC", "MC_Power");
    const b = lib("other", "OTHER", "MC_Power");
    const result = compile(
      `PROGRAM P
         VAR pwr : MC_Power; END_VAR
       END_PROGRAM`,
      { libraries: [a.archive, b.archive] },
    );
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => /ambiguous/i.test(e.message))).toBe(true);
  });

  it("qualified name still works after a clash", () => {
    const a = lib("mc", "MC", "MC_Power");
    const b = lib("other", "OTHER", "MC_Power");
    const result = compile(
      `PROGRAM P
         VAR pwr : MC.MC_Power; END_VAR
       END_PROGRAM`,
      { libraries: [a.archive, b.archive] },
    );
    expect(result.success).toBe(true);
    expect(result.headerCode).toContain("namespace MC");
    expect(result.headerCode).not.toContain("namespace OTHER");
  });

  it("builtin mc still wraps namespace MC so MC.MC_Power codegen matches", () => {
    const mc = lib("mc", "MC", "MC_Power");
    mc.archive!.manifest.isBuiltin = true;
    const result = compile(
      `PROGRAM P
         VAR pwr : MC.MC_Power; END_VAR
       END_PROGRAM`,
      { libraries: [mc.archive!] },
    );
    expect(result.success).toBe(true);
    expect(result.cppCode).toMatch(/namespace MC/);
  });

  it("registerLibrarySymbols stamps sourceNamespace", () => {
    const mc = lib("mc", "MC", "MC_Power");
    const tables = new SymbolTables();
    registerLibrarySymbols(mc.archive!.manifest, tables);
    const fb = tables.lookupFunctionBlock("MC_Power");
    expect(fb?.sourceNamespace).toBe("MC");
  });

  function fnLib(name: string, ns: string, fnName: string) {
    return compileStlib(
      [{
        fileName: `${name}.st`,
        source: `
          FUNCTION ${fnName} : INT
            VAR_INPUT X : INT; END_VAR
            ${fnName} := X;
          END_FUNCTION
        `,
      }],
      { name, version: "1.0.0", namespace: ns },
    );
  }

  it("bare function call is ambiguous when two libraries export it", () => {
    const a = fnLib("mc", "MC", "ClashFn");
    const b = fnLib("other", "OTHER", "ClashFn");
    const result = compile(
      `PROGRAM P
         VAR r : INT; END_VAR
         r := ClashFn(X := 1);
       END_PROGRAM`,
      { libraries: [a.archive, b.archive] },
    );
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => /ambiguous/i.test(e.message))).toBe(true);
    expect(result.errors.some((e) => /MC\.CLASHFN/i.test(e.message))).toBe(true);
    expect(result.errors.some((e) => /OTHER\.CLASHFN/i.test(e.message))).toBe(true);
  });

  it("qualified MC.ClashFn call resolves after a clash", () => {
    const a = fnLib("mc", "MC", "ClashFn");
    const b = fnLib("other", "OTHER", "ClashFn");
    const result = compile(
      `PROGRAM P
         VAR r : INT; END_VAR
         r := MC.ClashFn(X := 1);
       END_PROGRAM`,
      { libraries: [a.archive, b.archive] },
    );
    expect(result.success).toBe(true);
    expect(result.cppCode).toMatch(/MC::CLASHFN\(/);
    expect(result.cppCode).not.toContain("MC::MC.");
  });

  it("unambiguous bare function call still works", () => {
    const a = fnLib("mc", "MC", "ClashFn");
    const result = compile(
      `PROGRAM P
         VAR r : INT; END_VAR
         r := ClashFn(X := 1);
       END_PROGRAM`,
      { libraries: [a.archive] },
    );
    expect(result.success).toBe(true);
  });

  it("qualified FB instance call works after a clash", () => {
    const a = lib("mc", "MC", "MC_Power");
    const b = lib("other", "OTHER", "MC_Power");
    const result = compile(
      `PROGRAM P
         VAR pwr : MC.MC_Power; END_VAR
         pwr(Enable := TRUE);
       END_PROGRAM`,
      { libraries: [a.archive, b.archive] },
    );
    expect(result.success).toBe(true);
  });

  it("bare FB name call is ambiguous when two libraries export it", () => {
    const a = lib("mc", "MC", "MC_Power");
    const b = lib("other", "OTHER", "MC_Power");
    const result = compile(
      `PROGRAM P
         MC_Power(Enable := TRUE);
       END_PROGRAM`,
      { libraries: [a.archive, b.archive] },
    );
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => /ambiguous/i.test(e.message))).toBe(true);
    expect(result.errors.some((e) => /MC\.MC_POWER/i.test(e.message))).toBe(true);
    expect(result.errors.some((e) => /OTHER\.MC_POWER/i.test(e.message))).toBe(true);
  });

  it("qualified MC.MC_Power is an instance call, not a free function", () => {
    const a = lib("mc", "MC", "MC_Power");
    const b = lib("other", "OTHER", "MC_Power");
    const result = compile(
      `PROGRAM P
         VAR pwr : MC.MC_Power; END_VAR
         pwr(Enable := TRUE);
       END_PROGRAM`,
      { libraries: [a.archive, b.archive] },
    );
    expect(result.success).toBe(true);
    expect(result.cppCode).not.toMatch(/MC::MC_POWER\(/);
    expect(result.cppCode).not.toContain("MC::MC.");
  });

  it("bare FB type plus instance call is ambiguous when two libraries export it", () => {
    const a = lib("mc", "MC", "MC_Power");
    const b = lib("other", "OTHER", "MC_Power");
    const result = compile(
      `PROGRAM P
         VAR pwr : MC_Power; END_VAR
         pwr(Enable := TRUE);
       END_PROGRAM`,
      { libraries: [a.archive, b.archive] },
    );
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => /ambiguous/i.test(e.message))).toBe(true);
    expect(result.errors.some((e) => /MC\.MC_POWER/i.test(e.message))).toBe(true);
    expect(result.errors.some((e) => /OTHER\.MC_POWER/i.test(e.message))).toBe(true);
  });

  it("bare clash name as identifier is ambiguous not first-wins declared", () => {
    const a = fnLib("mc", "MC", "ClashFn");
    const b = fnLib("other", "OTHER", "ClashFn");
    const result = compile(
      `PROGRAM P
         VAR r : INT; END_VAR
         r := ClashFn;
       END_PROGRAM`,
      { libraries: [a.archive, b.archive] },
    );
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => /ambiguous/i.test(e.message))).toBe(true);
    expect(result.errors.some((e) => /MC\.CLASHFN/i.test(e.message))).toBe(true);
    expect(result.errors.some((e) => /OTHER\.CLASHFN/i.test(e.message))).toBe(true);
  });

  it("local variable still shadows an ambiguous library function name", () => {
    const a = fnLib("mc", "MC", "ClashFn");
    const b = fnLib("other", "OTHER", "ClashFn");
    const result = compile(
      `PROGRAM P
         VAR ClashFn : INT; END_VAR
         ClashFn := 1;
       END_PROGRAM`,
      { libraries: [a.archive, b.archive] },
    );
    expect(result.success).toBe(true);
  });

  it("MOCK_FUNCTION bare name is ambiguous when two libraries export it", () => {
    const a = fnLib("mc", "MC", "ClashFn");
    const b = fnLib("other", "OTHER", "ClashFn");
    const tables = new SymbolTables();
    registerLibrarySymbols(a.archive!.manifest, tables);
    registerLibrarySymbols(b.archive!.manifest, tables);

    const parseResult = parseTestFile(
      uppercaseSource(`
        TEST 'mock clash'
          MOCK_FUNCTION ClashFn RETURNS 1;
          ASSERT_TRUE(TRUE);
        END_TEST
      `),
      "test.st",
    );
    expect(parseResult.errors).toHaveLength(0);
    expect(parseResult.testFile).toBeDefined();

    const result = analyzeTestFile(parseResult.testFile!, tables);
    expect(result.errors.some((e) => /ambiguous/i.test(e.message))).toBe(true);
    expect(result.errors.some((e) => /MC\.CLASHFN/i.test(e.message))).toBe(true);
    expect(result.errors.some((e) => /OTHER\.CLASHFN/i.test(e.message))).toBe(true);
    expect(
      result.warnings.some((w) => /Unknown function/i.test(w.message)),
    ).toBe(false);
  });

  it("qualified OTHER.MC_Power still resolves after a clash", () => {
    const a = lib("mc", "MC", "MC_Power");
    const b = lib("other", "OTHER", "MC_Power");
    const result = compile(
      `PROGRAM P
         VAR pwr : OTHER.MC_Power; END_VAR
       END_PROGRAM`,
      { libraries: [a.archive, b.archive] },
    );
    expect(result.success).toBe(true);
  });

  it("bare clash names both namespaces and both library names", () => {
    const a = lib("mc", "MC", "MC_Power");
    const b = lib("other", "OTHER", "MC_Power");
    const result = compile(
      `PROGRAM P
         VAR pwr : MC_Power; END_VAR
       END_PROGRAM`,
      { libraries: [a.archive, b.archive] },
    );
    expect(result.success).toBe(false);
    const msg = result.errors.map((e) => e.message).join("\n");
    expect(msg).toMatch(/MC\.MC_POWER/);
    expect(msg).toMatch(/OTHER\.MC_POWER/);
    expect(msg).toMatch(/library 'mc'/);
    expect(msg).toMatch(/library 'other'/);
  });

  it("cross-library register keeps both qualified symbols", () => {
    const a = lib("mc", "MC", "MC_Power");
    const b = lib("other", "OTHER", "MC_Power");
    const tables = new SymbolTables();
    registerLibrarySymbols(a.archive!.manifest, tables);
    registerLibrarySymbols(b.archive!.manifest, tables);
    expect(tables.lookupFunctionBlock("MC.MC_Power")?.sourceLibrary).toBe("mc");
    expect(tables.lookupFunctionBlock("OTHER.MC_Power")?.sourceNamespace).toBe(
      "OTHER",
    );
    expect(tables.lookupFunctionBlock("OTHER.MC_Power")?.sourceLibrary).toBe(
      "other",
    );
    expect(tables.lookupFunctionBlock("MC_Power")).toBeUndefined();
    expect(tables.isAmbiguous("MC_Power")).toBe(true);
  });

  it("same library registered twice does not become ambiguous", () => {
    const a = lib("mc", "MC", "MC_Power");
    const tables = new SymbolTables();
    registerLibrarySymbols(a.archive!.manifest, tables);
    registerLibrarySymbols(a.archive!.manifest, tables);
    expect(tables.isAmbiguous("MC_Power")).toBe(false);
    expect(tables.lookupFunctionBlock("MC_Power")?.sourceLibrary).toBe("mc");
  });

  it("different library in the same namespace is rejected", () => {
    const a = lib("mc", "MC", "MC_Power");
    const b = lib("other", "MC", "MC_Power");
    const tables = new SymbolTables();
    registerLibrarySymbols(a.archive!.manifest, tables);
    expect(() => registerLibrarySymbols(b.archive!.manifest, tables)).toThrow(
      /namespace MC \(libraries mc and other\)/,
    );
    expect(tables.lookupFunctionBlock("MC_Power")?.sourceLibrary).toBe("mc");
  });

  it("unambiguous library emits using namespace", () => {
    const mc = lib("mc", "MC", "MC_Power");
    const result = compile(
      `PROGRAM P
         VAR pwr : MC_Power; END_VAR
       END_PROGRAM`,
      { libraries: [mc.archive!] },
    );
    expect(result.success).toBe(true);
    expect(result.headerCode).toContain("namespace MC");
    expect(result.headerCode).toContain("using namespace MC;");
  });

  it("clash omits a blanket using namespace", () => {
    const a = lib("mc", "MC", "MC_Power");
    const b = lib("other", "OTHER", "MC_Power");
    const result = compile(
      `PROGRAM P
         VAR pwr : MC.MC_Power; END_VAR
       END_PROGRAM`,
      { libraries: [a.archive, b.archive] },
    );
    expect(result.success).toBe(true);
    expect(result.headerCode).not.toContain("using namespace MC;");
    expect(result.headerCode).not.toContain("using namespace OTHER;");
  });

  it("same namespace behind a builtin is not silently dropped", () => {
    const tables = new SymbolTables();
    const first = loadLibraryManifest({
      name: "iec-a",
      version: "1.0.0",
      namespace: "strucpp",
      functions: [{ name: "TIME", returnType: "TIME", parameters: [] }],
      functionBlocks: [],
      types: [],
      headers: [],
      isBuiltin: true,
    });
    const second = loadLibraryManifest({
      name: "iec-b",
      version: "1.0.0",
      namespace: "strucpp",
      functions: [{ name: "TIME", returnType: "TIME", parameters: [] }],
      functionBlocks: [],
      types: [],
      headers: [],
      isBuiltin: true,
    });
    registerLibrarySymbols(first, tables);
    expect(() => registerLibrarySymbols(second, tables)).toThrow(
      /namespace strucpp \(libraries iec-a and iec-b\)/,
    );
    expect(tables.lookupType("TIME")).toBeDefined();
  });

  it("bare global clash is an error naming both libraries", () => {
    const globalLib = (name: string, ns: string) =>
      compileStlib(
        [{
          fileName: `${name}.st`,
          source: `
            VAR_GLOBAL
              ClashG : INT;
            END_VAR
          `,
        }],
        { name, version: "1.0.0", namespace: ns },
      );
    const a = globalLib("mc", "MC");
    const b = globalLib("other", "OTHER");
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    const result = compile(
      `PROGRAM P
         VAR r : INT; END_VAR
         r := ClashG;
       END_PROGRAM`,
      { libraries: [a.archive, b.archive] },
    );
    expect(result.success).toBe(false);
    const msg = result.errors.map((e) => e.message).join("\n");
    expect(msg).toMatch(/MC\.CLASHG/);
    expect(msg).toMatch(/OTHER\.CLASHG/);
    expect(msg).toMatch(/library 'mc'/);
    expect(msg).toMatch(/library 'other'/);
  });

  it("qualified global is emitted as a C++ namespace qualifier", () => {
    const globalLib = (name: string, ns: string) =>
      compileStlib(
        [{
          fileName: `${name}.st`,
          source: `
            VAR_GLOBAL
              ClashG : INT;
            END_VAR
          `,
        }],
        { name, version: "1.0.0", namespace: ns },
      );
    const a = globalLib("mc", "MC");
    const b = globalLib("other", "OTHER");
    const result = compile(
      `PROGRAM P
         VAR r : INT; END_VAR
         r := MC.ClashG;
       END_PROGRAM`,
      { libraries: [a.archive, b.archive] },
    );
    expect(result.success).toBe(true);
    expect(result.headerCode).toContain("namespace MC");
    expect(result.headerCode).not.toContain("namespace OTHER");
    expect(result.headerCode).toContain("CLASHG");
    expect(result.cppCode).toMatch(/MC::CLASHG/);
  });

  it("builtin elementary name is not a cross-library clash", () => {
    const tables = new SymbolTables();
    const manifest = loadLibraryManifest({
      name: "iec-std-functions",
      version: "1.0.0",
      namespace: "strucpp",
      functions: [{ name: "TIME", returnType: "TIME", parameters: [] }],
      functionBlocks: [],
      types: [],
      headers: [],
      isBuiltin: true,
    });
    expect(() => registerLibrarySymbols(manifest, tables)).not.toThrow();
    expect(tables.lookupType("TIME")).toBeDefined();
  });

  it("iec-standard-fb stays flat inside namespace strucpp", () => {
    const fb = lib("iec-standard-fb", "IEC", "TON");
    expect(fb.success).toBe(true);
    const result = compile(
      `PROGRAM P
         VAR t : TON; END_VAR
       END_PROGRAM`,
      { libraries: [fb.archive!] },
    );
    expect(result.success).toBe(true);
    expect(result.headerCode).not.toContain("namespace IEC");
    expect(result.cppCode).not.toContain("namespace IEC");
  });
});
