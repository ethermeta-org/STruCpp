/**
 * Library interfaces survive --compile-lib and are usable from -L.
 *
 * An archive compiled before the field existed still loads. A consumer
 * can name the interface, IMPLEMENTS it, and read or write a property.
 * A missing member fails and names the interface and the member.
 * One fixture library can EXTENDS a function block from another.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { compileStlib } from "../../src/library/library-compiler.js";
import {
  LibraryManifestError,
  loadLibraryManifest,
} from "../../src/library/library-loader.js";
import {
  LIBRARY_PROPERTY_ACCESS_READONLY,
  LIBRARY_PROPERTY_ACCESS_READWRITE,
  LIBRARY_PROPERTY_ACCESS_WRITEONLY,
  LIBRARY_CHUNK_KIND_INTERFACE,
} from "../../src/library/library-manifest.js";
import {
  compileAndRunStandalone,
  createPCH,
  hasGpp,
} from "../integration/test-helpers.js";

const IFACE_SOURCE = `
  INTERFACE IGATE
    METHOD PULSE : INT
    END_METHOD
    PROPERTY LEVEL : INT
    END_PROPERTY
    PROPERTY SEEN : BOOL
      GET
      END_GET
    END_PROPERTY
    PROPERTY CMD : INT
      SET
      END_SET
    END_PROPERTY
  END_INTERFACE
`;

const GATE_SOURCE = `
  FUNCTION_BLOCK GATE IMPLEMENTS IGATE
    VAR levelState : INT; END_VAR
    METHOD PULSE : INT
      PULSE := 7;
    END_METHOD
    PROPERTY LEVEL : INT
      GET
        LEVEL := levelState;
      END_GET
      SET
        levelState := LEVEL;
      END_SET
    END_PROPERTY
    PROPERTY SEEN : BOOL
      GET
        SEEN := TRUE;
      END_GET
    END_PROPERTY
    PROPERTY CMD : INT
      SET
        levelState := CMD;
      END_SET
    END_PROPERTY
  END_FUNCTION_BLOCK
`;

const GATE2_SOURCE = `
  FUNCTION_BLOCK GATE2 EXTENDS GATE
    METHOD READ : INT
      READ := SUPER^.PULSE();
    END_METHOD
  END_FUNCTION_BLOCK
`;

function compileIface() {
  return compileStlib([{ source: IFACE_SOURCE, fileName: "igate.st" }], {
    name: "gate-iface",
    version: "1.0.0",
    namespace: "GATEIF",
  });
}

describe("library interfaces", () => {
  it("exports name, EXTENDS, methods, and property direction", () => {
    const built = compileIface();
    expect(built.success, built.errors.map((e) => e.message).join("\n")).toBe(
      true,
    );
    const iface = built.archive.manifest.interfaces?.find(
      (entry) => entry.name === "IGATE",
    );
    expect(iface).toBeDefined();
    expect(iface?.extends).toBeUndefined();
    expect(iface?.methods.map((method) => method.name)).toEqual(["PULSE"]);
    expect(iface?.methods[0]?.returnType).toEqual({ type: "INT" });
    const access = Object.fromEntries(
      (iface?.properties ?? []).map((prop) => [prop.name, prop.access]),
    );
    expect(access).toEqual({
      LEVEL: LIBRARY_PROPERTY_ACCESS_READWRITE,
      SEEN: LIBRARY_PROPERTY_ACCESS_READONLY,
      CMD: LIBRARY_PROPERTY_ACCESS_WRITEONLY,
    });
    const chunk = built.archive.chunks.find((item) => item.name === "IGATE");
    expect(chunk?.kind).toBe(LIBRARY_CHUNK_KIND_INTERFACE);
    expect(chunk?.header).toContain("class IGATE");
    expect(chunk?.header).toContain("get_SEEN");
    expect(chunk?.header).not.toContain("set_SEEN");
    expect(chunk?.header).toContain("set_CMD");
    expect(chunk?.header).not.toContain("get_CMD");
  });

  it("loads an old manifest that has no interfaces field", () => {
    const manifest = loadLibraryManifest({
      name: "old",
      version: "1.0.0",
      namespace: "OLD",
      functions: [],
      functionBlocks: [],
      types: [],
      headers: [],
      isBuiltin: false,
    });
    expect(manifest.interfaces).toEqual([]);
  });

  it("rejects an interfaces field that is not an array", () => {
    expect(() =>
      loadLibraryManifest({
        name: "bad",
        version: "1.0.0",
        namespace: "BAD",
        functions: [],
        functionBlocks: [],
        types: [],
        headers: [],
        isBuiltin: false,
        interfaces: {},
      }),
    ).toThrow(LibraryManifestError);
  });

  it("rejects a consumer that IMPLEMENTS a library interface and omits a member", () => {
    const iface = compileIface();
    expect(iface.success).toBe(true);
    const result = compile(
      `
        FUNCTION_BLOCK BROKEN IMPLEMENTS IGATE
        END_FUNCTION_BLOCK
      `,
      { libraries: [iface.archive] },
    );
    expect(result.success).toBe(false);
    const text = result.errors.map((err) => err.message).join("\n");
    expect(text).toContain("IGATE");
    expect(text).toContain("PULSE");
  });

  it("rejects an implementation that swaps same-typed output names", () => {
    const built = compileStlib(
      [
        {
          source: `
            INTERFACE IPAIR
              METHOD READ
                VAR_OUTPUT
                  a : BOOL;
                  b : BOOL;
                END_VAR
              END_METHOD
            END_INTERFACE
          `,
          fileName: "ipair.st",
        },
      ],
      { name: "pair-iface", version: "1.0.0", namespace: "PAIR" },
    );
    expect(built.success).toBe(true);
    const result = compile(
      `
        FUNCTION_BLOCK BAD IMPLEMENTS IPAIR
          METHOD READ
            VAR_OUTPUT
              b : BOOL;
              a : BOOL;
            END_VAR
          END_METHOD
        END_FUNCTION_BLOCK
      `,
      { libraries: [built.archive] },
    );
    expect(result.success).toBe(false);
    const text = result.errors.map((err) => err.message).join("\n");
    expect(text).toContain("IPAIR");
    expect(text).toContain("READ");
  });

  it("rejects a method whose signature does not match the library interface", () => {
    const iface = compileIface();
    expect(iface.success).toBe(true);
    const result = compile(
      `
        FUNCTION_BLOCK BROKEN IMPLEMENTS IGATE
          METHOD PULSE : BOOL
            PULSE := FALSE;
          END_METHOD
        END_FUNCTION_BLOCK
      `,
      { libraries: [iface.archive] },
    );
    expect(result.success).toBe(false);
    const text = result.errors.map((err) => err.message).join("\n");
    expect(text).toContain("IGATE");
    expect(text).toContain("PULSE");
  });

  it("assigns a derived library interface to its parent", () => {
    const built = compileStlib(
      [
        {
          source: `
            INTERFACE IBASE
              METHOD PING : INT
              END_METHOD
            END_INTERFACE
            INTERFACE IDERIVED EXTENDS IBASE
            END_INTERFACE
          `,
          fileName: "ibase.st",
        },
      ],
      { name: "gate-iface", version: "1.0.0", namespace: "GATEIF" },
    );
    expect(built.success, built.errors.map((e) => e.message).join("\n")).toBe(
      true,
    );
    const result = compile(
      `
        PROGRAM Main
          VAR
            child : GATEIF.IDERIVED;
            base : GATEIF.IBASE;
          END_VAR
          base := child;
        END_PROGRAM
      `,
      { libraries: [built.archive] },
    );
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(
      true,
    );
  });

  it("records cppName when a member collides with a dependency interface method", () => {
    const iface = compileIface();
    expect(iface.success).toBe(true);
    const gate = compileStlib(
      [
        {
          source: `
            FUNCTION_BLOCK GATE IMPLEMENTS IGATE
              VAR PULSE : INT; END_VAR
              METHOD PULSE : INT
                PULSE := 1;
              END_METHOD
              PROPERTY LEVEL : INT
                GET
                  LEVEL := PULSE;
                END_GET
                SET
                  PULSE := LEVEL;
                END_SET
              END_PROPERTY
              PROPERTY SEEN : BOOL
                GET
                  SEEN := TRUE;
                END_GET
              END_PROPERTY
              PROPERTY CMD : INT
                SET
                  PULSE := CMD;
                END_SET
              END_PROPERTY
            END_FUNCTION_BLOCK
          `,
          fileName: "gate.st",
        },
      ],
      {
        name: "gate-base",
        version: "1.0.0",
        namespace: "GATEBASE",
        dependencies: [iface.archive],
      },
    );
    expect(gate.success, gate.errors.map((e) => e.message).join("\n")).toBe(
      true,
    );
    const fb = gate.archive.manifest.functionBlocks.find(
      (entry) => entry.name === "GATE",
    );
    const pulse = fb?.locals?.find((local) => local.name === "PULSE");
    expect(pulse?.cppName).toBe("PULSE_");
  });

  it("keeps a qualified IMPLEMENTS interface in the linked header", () => {
    const iface = compileIface();
    expect(iface.success).toBe(true);
    const result = compile(
      `
        FUNCTION_BLOCK BOX IMPLEMENTS GATEIF.IGATE
          METHOD PULSE : INT
            PULSE := 1;
          END_METHOD
          PROPERTY LEVEL : INT
            GET
              LEVEL := 1;
            END_GET
            SET
            END_SET
          END_PROPERTY
          PROPERTY SEEN : BOOL
            GET
              SEEN := FALSE;
            END_GET
          END_PROPERTY
          PROPERTY CMD : INT
            SET
            END_SET
          END_PROPERTY
        END_FUNCTION_BLOCK
        PROGRAM Main
          VAR b : BOX; END_VAR
        END_PROGRAM
      `,
      { libraries: [iface.archive] },
    );
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(
      true,
    );
    expect(result.headerCode).toContain("class IGATE");
    expect(result.headerCode).toContain("GATEIF::IGATE");
  });

  it("makes a derived getter const when the library base implements the property", () => {
    const iface = compileIface();
    const gate = compileStlib([{ source: GATE_SOURCE, fileName: "gate.st" }], {
      name: "gate-base",
      version: "1.0.0",
      namespace: "GATEBASE",
      dependencies: [iface.archive],
    });
    expect(gate.success, gate.errors.map((e) => e.message).join("\n")).toBe(
      true,
    );
    const result = compile(
      `
        FUNCTION_BLOCK CHILD EXTENDS GATEBASE.GATE
          PROPERTY SEEN : BOOL
            GET
              SEEN := FALSE;
            END_GET
          END_PROPERTY
        END_FUNCTION_BLOCK
        PROGRAM Main
          VAR c : CHILD; END_VAR
        END_PROGRAM
      `,
      { libraries: [iface.archive, gate.archive] },
    );
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(
      true,
    );
    expect(result.headerCode).toMatch(/get_SEEN\(\) const/);
  });

  it("rejects a write to a read-only library property", () => {
    const iface = compileIface();
    expect(iface.success).toBe(true);
    const result = compile(
      `
        PROGRAM Main
          VAR itf : GATEIF.IGATE; END_VAR
          itf.SEEN := TRUE;
        END_PROGRAM
      `,
      { libraries: [iface.archive] },
    );
    expect(result.success).toBe(false);
    const text = result.errors.map((err) => err.message).join("\n");
    expect(text).toContain("SEEN");
    expect(text.toLowerCase()).toContain("read-only");
  });
});

describe.skipIf(!hasGpp)("library interface consumption", () => {
  let tempDir: string;
  let pchPath: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-iface-"));
    pchPath = createPCH(tempDir);
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("calls a base method through EXTENDS and queries the library interface", () => {
    const iface = compileIface();
    expect(iface.success, iface.errors.map((e) => e.message).join("\n")).toBe(
      true,
    );
    const gate = compileStlib([{ source: GATE_SOURCE, fileName: "gate.st" }], {
      name: "gate-base",
      version: "1.0.0",
      namespace: "GATEBASE",
      dependencies: [iface.archive],
    });
    expect(gate.success, gate.errors.map((e) => e.message).join("\n")).toBe(
      true,
    );
    const derived = compileStlib(
      [{ source: GATE2_SOURCE, fileName: "gate2.st" }],
      {
        name: "gate-derived",
        version: "1.0.0",
        namespace: "GATEDER",
        dependencies: [gate.archive],
      },
    );
    expect(
      derived.success,
      derived.errors.map((e) => e.message).join("\n"),
    ).toBe(true);
    expect(derived.archive.chunks.some((chunk) => chunk.name === "GATE2")).toBe(
      true,
    );

    const result = compile(
      `
        PROGRAM Main
          VAR
            itf : GATEIF.IGATE;
            n : INT;
            g : GATE;
            g2 : GATE2;
            v : INT;
            ok : BOOL;
          END_VAR
          n := itf.LEVEL;
          itf.LEVEL := n;
          v := g2.READ();
          ok := __QUERYINTERFACE(g, itf);
        END_PROGRAM
      `,
      { libraries: [iface.archive, gate.archive, derived.archive] },
    );
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(
      true,
    );
    expect(result.headerCode).toContain("IEC_ITF<GATEIF::IGATE>");
    expect(result.cppCode).toContain("dynamic_cast<GATEIF::IGATE");
    expect(result.cppCode).toContain("PULSE");

    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "lib_iface_extends",
      mainCode: `
        #include "generated.hpp"
        #include <iostream>
        int main() {
          strucpp::Program_MAIN prog;
          prog.run();
          std::cout << static_cast<int>(prog.V) << std::endl;
          return 0;
        }
      `,
    });
    expect(stdout).toBe("7");
  });

  it("compiles an interface compared with NULL", () => {
    const result = compile(`
      INTERFACE IFLAG
      END_INTERFACE
      PROGRAM Main
        VAR
          itf : IFLAG;
          ok : BOOL;
        END_VAR
        itf := NULL;
        ok := itf = NULL;
      END_PROGRAM
    `);
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(
      true,
    );
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "itf_null",
      mainCode: `
        #include "generated.hpp"
        #include <iostream>
        int main() {
          strucpp::Program_MAIN prog;
          prog.run();
          std::cout << (prog.OK ? 1 : 0) << std::endl;
          return 0;
        }
      `,
    });
    expect(stdout).toBe("1");
  });
});
