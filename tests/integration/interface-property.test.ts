/**
 * Interface properties (interface-declaration PROPERTY support).
 *
 * Covers the CODESYS interface-property semantics the behaviour-model
 * library needs:
 * - `PROPERTY Name : Type` in an INTERFACE carries no accessor statements;
 *   no accessors = read-write, an empty `GET` = read-only, an empty
 *   `SET` = write-only
 * - IMPLEMENTS checks name, type, and access direction along the
 *   interface EXTENDS chain; the FB's own EXTENDS chain may provide
 *   the property; ABSTRACT FBs are exempt
 * - reading/writing through an interface reference dispatches to the
 *   implementation's accessors; an unbound reference reads the type's
 *   zero value and ignores writes — the process must exit cleanly
 * - writing a read-only property and reading a write-only one are
 *   compile errors naming the interface and the property
 *
 * The E2E cases compile the generated C++ with g++ (-std=c++14) and run it.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { hasGpp, runE2ETestPipeline } from "./test-helpers.js";

/** Read-write, read-only, and inherited-property interfaces with FBs. */
const FIXTURE_ST = `
INTERFACE IHas
    PROPERTY Speed : INT
    END_PROPERTY
END_INTERFACE

INTERFACE IRead
    PROPERTY Speed : INT
        GET
        END_GET
    END_PROPERTY
END_INTERFACE

INTERFACE IChild EXTENDS IHas
END_INTERFACE

FUNCTION_BLOCK HasImpl IMPLEMENTS IHas
VAR
    speedVal : INT;
END_VAR
    PROPERTY Speed : INT
        GET
            Speed := speedVal;
        END_GET
        SET
            speedVal := Speed;
        END_SET
    END_PROPERTY
END_FUNCTION_BLOCK

FUNCTION_BLOCK ReadImpl IMPLEMENTS IRead
VAR
    speedVal : INT := 7;
END_VAR
    PROPERTY Speed : INT
        GET
            Speed := speedVal;
        END_GET
    END_PROPERTY
END_FUNCTION_BLOCK

FUNCTION_BLOCK ChildImpl IMPLEMENTS IChild
VAR
    speedVal : INT;
END_VAR
    PROPERTY Speed : INT
        GET
            Speed := speedVal;
        END_GET
        SET
            speedVal := Speed;
        END_SET
    END_PROPERTY
END_FUNCTION_BLOCK

FUNCTION_BLOCK Host
VAR_OUTPUT
    gotRw : INT;
    gotRo : INT;
    gotChild : INT;
    gotUnbound : INT;
    gotUnboundAfterWrite : INT;
END_VAR
VAR
    rw : HasImpl;
    ro : ReadImpl;
    child : ChildImpl;
    itfRw : IHas;
    itfRo : IRead;
    itfChild : IChild;
    itfNone : IHas;
END_VAR
    itfRw := rw;
    itfRw.Speed := 42;
    gotRw := itfRw.Speed;
    itfRo := ro;
    gotRo := itfRo.Speed;
    itfChild := child;
    itfChild.Speed := 5;
    gotChild := itfChild.Speed;
    gotUnbound := itfNone.Speed;
    itfNone.Speed := 9;
    gotUnboundAfterWrite := itfNone.Speed;
END_FUNCTION_BLOCK
`;

describe("Interface properties (codegen shape)", () => {
  it("emits pure-virtual accessors per the declared direction", () => {
    const result = compile(FIXTURE_ST);
    expect(result.success).toBe(true);
    // Read-write (no accessors): both accessors on the interface class
    expect(result.headerCode).toContain(
      "virtual IEC_INT get_SPEED() const = 0;",
    );
    expect(result.headerCode).toContain(
      "virtual void set_SPEED(IEC_INT SPEED) = 0;",
    );
    // Read-only (empty GET): the IREAD class has a getter and no setter.
    // Searching the whole header for get_SPEED would pass on IHAS alone.
    const iread =
      result.headerCode.split("class IREAD ")[1]?.split("\nclass ")[0] ?? "";
    expect(iread).toContain("virtual IEC_INT get_SPEED() const = 0;");
    expect(iread).not.toContain("set_SPEED");
  });

  it("dispatches reference reads and writes through guarded accessor calls", () => {
    const result = compile(FIXTURE_ST);
    expect(result.success).toBe(true);
    // Read: unbound yields the property type's zero value
    expect(result.cppCode).toContain(
      "ITFRW.get() != nullptr ? ITFRW->get_SPEED()",
    );
    expect(result.cppCode).toContain(": IEC_INT(0))");
    // Write: one null guard around one virtual setter call
    expect(result.cppCode).toContain(
      "if (ITFRW.get() != nullptr) { ITFRW->set_SPEED(42); }",
    );
    expect(result.cppCode).toContain(
      "if (ITFNONE.get() != nullptr) { ITFNONE->set_SPEED(9); }",
    );
  });

  it("dispatches a property access on an interface-typed FB member", () => {
    const result = compile(`
INTERFACE IHas
    PROPERTY Speed : INT
    END_PROPERTY
END_INTERFACE
FUNCTION_BLOCK HasImpl IMPLEMENTS IHas
VAR speedVal : INT; END_VAR
    PROPERTY Speed : INT
        GET Speed := speedVal; END_GET
        SET speedVal := Speed; END_SET
    END_PROPERTY
END_FUNCTION_BLOCK
FUNCTION_BLOCK Host
VAR_OUTPUT y : INT; END_VAR
VAR
    inner : HasImpl;
    itf : IHas;
END_VAR
    itf := inner;
    itf.Speed := 11;
    y := itf.Speed;
END_FUNCTION_BLOCK
PROGRAM Main
VAR
    host : Host;
    z : INT;
END_VAR
    host();
    z := host.itf.Speed;
END_PROGRAM
`);
    expect(result.success).toBe(true);
    // Chained access through an FB member of interface type takes the same
    // guarded virtual-getter path.
    expect(result.cppCode).toContain(
      "HOST_.ITF.get() != nullptr ? HOST_.ITF->get_SPEED()",
    );
  });
});

describe.skipIf(!hasGpp)("Interface properties (g++ -std=c++14, run)", () => {
  it("reads back what was written and survives unbound access", () => {
    const testST = `
TEST 'write then read through the reference round-trips'
  VAR host : Host; END_VAR
  host();
  ASSERT_EQ(host.gotRw, 42);
  ASSERT_EQ(host.gotChild, 5);
END_TEST

TEST 'read-only property dispatches to the implementation getter'
  VAR host : Host; END_VAR
  host();
  ASSERT_EQ(host.gotRo, 7);
END_TEST

TEST 'unbound reference reads zero and ignores writes'
  VAR host : Host; END_VAR
  host();
  ASSERT_EQ(host.gotUnbound, 0);
  ASSERT_EQ(host.gotUnboundAfterWrite, 0);
END_TEST
`;
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: FIXTURE_ST,
      testST,
      tempDirPrefix: "strucpp-iface-prop-",
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("3 tests, 3 passed, 0 failed");
  });
});

describe("Interface property IMPLEMENTS diagnostics", () => {
  it("rejects an implementation missing the property entirely", () => {
    const result = compile(`
INTERFACE IHas
    PROPERTY Speed : INT
    END_PROPERTY
END_INTERFACE
FUNCTION_BLOCK Empty IMPLEMENTS IHas
END_FUNCTION_BLOCK
`);
    expect(result.success).toBe(false);
    const message = result.errors.map((e) => e.message).join("\n");
    expect(message).toContain("IHAS");
    expect(message).toContain("does not provide property");
    expect(message).toContain("SPEED");
  });

  it("requires GET and SET for a read-write interface property", () => {
    const getterOnly = compile(`
INTERFACE IHas
    PROPERTY Speed : INT
    END_PROPERTY
END_INTERFACE
FUNCTION_BLOCK Half IMPLEMENTS IHas
VAR speedVal : INT; END_VAR
    PROPERTY Speed : INT
        GET Speed := speedVal; END_GET
    END_PROPERTY
END_FUNCTION_BLOCK
`);
    expect(getterOnly.success).toBe(false);
    const message = getterOnly.errors.map((e) => e.message).join("\n");
    expect(message).toContain("IHAS");
    expect(message).toContain("SPEED");
    expect(message).toContain("missing a SET accessor");

    const setterOnly = compile(`
INTERFACE IHas
    PROPERTY Speed : INT
    END_PROPERTY
END_INTERFACE
FUNCTION_BLOCK Half IMPLEMENTS IHas
VAR speedVal : INT; END_VAR
    PROPERTY Speed : INT
        SET speedVal := Speed; END_SET
    END_PROPERTY
END_FUNCTION_BLOCK
`);
    expect(setterOnly.success).toBe(false);
    expect(setterOnly.errors.map((e) => e.message).join("\n")).toContain(
      "missing a GET accessor",
    );
  });

  it("accepts a GET-only implementation of a read-only interface property", () => {
    const result = compile(`
INTERFACE IRead
    PROPERTY Speed : INT
        GET
        END_GET
    END_PROPERTY
END_INTERFACE
FUNCTION_BLOCK ReadImpl IMPLEMENTS IRead
VAR speedVal : INT; END_VAR
    PROPERTY Speed : INT
        GET Speed := speedVal; END_GET
    END_PROPERTY
END_FUNCTION_BLOCK
PROGRAM Main END_PROGRAM
`);
    expect(result.success).toBe(true);
  });

  it("requires the property of a parent interface when implementing a child", () => {
    const result = compile(`
INTERFACE IHas
    PROPERTY Speed : INT
    END_PROPERTY
END_INTERFACE
INTERFACE IChild EXTENDS IHas
END_INTERFACE
FUNCTION_BLOCK ChildImpl IMPLEMENTS IChild
END_FUNCTION_BLOCK
`);
    expect(result.success).toBe(false);
    const message = result.errors.map((e) => e.message).join("\n");
    expect(message).toContain("ICHILD");
    expect(message).toContain("does not provide property");
    expect(message).toContain("SPEED");
  });

  it("reports both type names on a mismatched property type", () => {
    const result = compile(`
INTERFACE IHas
    PROPERTY Speed : INT
    END_PROPERTY
END_INTERFACE
FUNCTION_BLOCK Wide IMPLEMENTS IHas
VAR speedVal : DINT; END_VAR
    PROPERTY Speed : DINT
        GET Speed := speedVal; END_GET
        SET speedVal := Speed; END_SET
    END_PROPERTY
END_FUNCTION_BLOCK
`);
    expect(result.success).toBe(false);
    const message = result.errors.map((e) => e.message).join("\n");
    expect(message).toContain("SPEED");
    expect(message).toContain("INT");
    expect(message).toContain("DINT");
  });

  it("exempts ABSTRACT function blocks from the property contract", () => {
    const result = compile(`
INTERFACE IHas
    PROPERTY Speed : INT
    END_PROPERTY
END_INTERFACE
FUNCTION_BLOCK ABSTRACT Partial IMPLEMENTS IHas
END_FUNCTION_BLOCK
`);
    expect(result.success).toBe(true);
  });

  it("counts a property inherited through the FB EXTENDS chain as provided", () => {
    const result = compile(`
INTERFACE IHas
    PROPERTY Speed : INT
    END_PROPERTY
END_INTERFACE
FUNCTION_BLOCK Base
VAR speedVal : INT; END_VAR
    PROPERTY Speed : INT
        GET Speed := speedVal; END_GET
        SET speedVal := Speed; END_SET
    END_PROPERTY
END_FUNCTION_BLOCK
FUNCTION_BLOCK Derived EXTENDS Base IMPLEMENTS IHas
END_FUNCTION_BLOCK
PROGRAM Main END_PROGRAM
`);
    expect(result.success).toBe(true);
  });
});

describe("Interface property source rules", () => {
  it("rejects statements inside an interface accessor", () => {
    const result = compile(`
INTERFACE IBad
    PROPERTY Speed : INT
        GET
            Speed := 1;
        END_GET
    END_PROPERTY
END_INTERFACE
`);
    expect(result.success).toBe(false);
    const message = result.errors.map((e) => e.message).join("\n");
    expect(message).toContain("IBAD");
    expect(message).toContain("SPEED");
    expect(message).toContain("cannot contain statements");
  });

  it("rejects writing a read-only property through a reference", () => {
    const result = compile(`
INTERFACE IRead
    PROPERTY Speed : INT
        GET
        END_GET
    END_PROPERTY
END_INTERFACE
FUNCTION_BLOCK ReadImpl IMPLEMENTS IRead
VAR speedVal : INT; END_VAR
    PROPERTY Speed : INT
        GET Speed := speedVal; END_GET
    END_PROPERTY
END_FUNCTION_BLOCK
FUNCTION_BLOCK Host
VAR
    ro : ReadImpl;
    itfRo : IRead;
END_VAR
    itfRo := ro;
    itfRo.Speed := 3;
END_FUNCTION_BLOCK
`);
    expect(result.success).toBe(false);
    const message = result.errors.map((e) => e.message).join("\n");
    expect(message).toContain("read-only");
    expect(message).toContain("IREAD");
    expect(message).toContain("SPEED");
  });

  it("rejects reading a write-only property through a reference", () => {
    const result = compile(`
INTERFACE IWrite
    PROPERTY Speed : INT
        SET
        END_SET
    END_PROPERTY
END_INTERFACE
FUNCTION_BLOCK WriteImpl IMPLEMENTS IWrite
VAR speedVal : INT; END_VAR
    PROPERTY Speed : INT
        SET speedVal := Speed; END_SET
    END_PROPERTY
END_FUNCTION_BLOCK
FUNCTION_BLOCK Host
VAR_OUTPUT y : INT; END_VAR
VAR
    wr : WriteImpl;
    itfWr : IWrite;
END_VAR
    itfWr := wr;
    y := itfWr.Speed;
END_FUNCTION_BLOCK
`);
    expect(result.success).toBe(false);
    const message = result.errors.map((e) => e.message).join("\n");
    expect(message).toContain("write-only");
    expect(message).toContain("IWRITE");
    expect(message).toContain("SPEED");
  });

  it("rejects a method and a property with the same name", () => {
    const result = compile(`
INTERFACE IBad
    METHOD Speed : INT
    END_METHOD
    PROPERTY Speed : INT
    END_PROPERTY
END_INTERFACE
`);
    expect(result.success).toBe(false);
    const message = result.errors.map((e) => e.message).join("\n");
    expect(message).toContain("method");
    expect(message).toContain("property");
    expect(message).toContain("SPEED");
  });

  it("rejects two parent interfaces whose same-named properties differ in type", () => {
    const result = compile(`
INTERFACE I1
    PROPERTY Speed : INT
    END_PROPERTY
END_INTERFACE
INTERFACE I2
    PROPERTY Speed : DINT
    END_PROPERTY
END_INTERFACE
INTERFACE IBoth EXTENDS I1, I2
END_INTERFACE
`);
    expect(result.success).toBe(false);
    const message = result.errors.map((e) => e.message).join("\n");
    expect(message).toContain("IBOTH");
    expect(message).toContain("SPEED");
    expect(message).toContain("different type or access direction");
    expect(message).toContain("DINT");
  });

  it("rejects two parent interfaces whose same-named properties differ in direction", () => {
    const result = compile(`
INTERFACE I1
    PROPERTY Speed : INT
        GET
        END_GET
    END_PROPERTY
END_INTERFACE
INTERFACE I2
    PROPERTY Speed : INT
        SET
        END_SET
    END_PROPERTY
END_INTERFACE
INTERFACE IBoth EXTENDS I1, I2
END_INTERFACE
`);
    expect(result.success).toBe(false);
    const message = result.errors.map((e) => e.message).join("\n");
    expect(message).toContain("IBOTH");
    expect(message).toContain("SPEED");
    expect(message).toContain("different type or access direction");
    expect(message).toContain("read-only");
    expect(message).toContain("write-only");
  });

  it("rejects VAR directly inside an interface", () => {
    const result = compile(`
INTERFACE IBad
VAR
    x : INT;
END_VAR
END_INTERFACE
`);
    expect(result.success).toBe(false);
  });

  it("does not count a PRIVATE property as the IMPLEMENTS implementation", () => {
    const result = compile(`
INTERFACE IHas
    PROPERTY Speed : INT
    END_PROPERTY
END_INTERFACE
FUNCTION_BLOCK Secret IMPLEMENTS IHas
VAR
    speedVal : INT;
END_VAR
    PROPERTY PRIVATE Speed : INT
        GET
            Speed := speedVal;
        END_GET
        SET
            speedVal := Speed;
        END_SET
    END_PROPERTY
END_FUNCTION_BLOCK
`);
    expect(result.success).toBe(false);
    const message = result.errors.map((e) => e.message).join("\n");
    expect(message).toContain("does not provide property");
    expect(message).toContain("SPEED");
  });

  it("compares string length and array bounds when checking a property type", () => {
    const length = compile(`
INTERFACE IHas
    PROPERTY Name : STRING(10)
END_PROPERTY
END_INTERFACE
FUNCTION_BLOCK Wide IMPLEMENTS IHas
    PROPERTY Name : STRING(20)
        GET
        END_GET
        SET
        END_SET
    END_PROPERTY
END_FUNCTION_BLOCK
`);
    expect(length.success).toBe(false);
    const lengthMessage = length.errors.map((e) => e.message).join("\n");
    expect(lengthMessage).toContain("STRING(10)");
    expect(lengthMessage).toContain("STRING(20)");

    const bounds = compile(`
INTERFACE IHas
    PROPERTY Samples : ARRAY[0..3] OF INT
    END_PROPERTY
END_INTERFACE
FUNCTION_BLOCK Wide IMPLEMENTS IHas
    PROPERTY Samples : ARRAY[0..7] OF INT
        GET
        END_GET
        SET
        END_SET
    END_PROPERTY
END_FUNCTION_BLOCK
`);
    expect(bounds.success).toBe(false);
    const boundsMessage = bounds.errors.map((e) => e.message).join("\n");
    expect(boundsMessage).toContain("0..3");
    expect(boundsMessage).toContain("0..7");
  });

  it("requires a concrete block to satisfy an ABSTRACT ancestor's interface", () => {
    const missing = compile(`
INTERFACE IHas
    PROPERTY Speed : INT
    END_PROPERTY
END_INTERFACE
FUNCTION_BLOCK ABSTRACT Partial IMPLEMENTS IHas
END_FUNCTION_BLOCK
FUNCTION_BLOCK Concrete EXTENDS Partial
END_FUNCTION_BLOCK
`);
    expect(missing.success).toBe(false);
    expect(missing.errors.map((e) => e.message).join("\n")).toContain(
      "does not provide property",
    );

    const provided = compile(`
INTERFACE IHas
    PROPERTY Speed : INT
    END_PROPERTY
END_INTERFACE
FUNCTION_BLOCK ABSTRACT Partial IMPLEMENTS IHas
END_FUNCTION_BLOCK
FUNCTION_BLOCK Concrete EXTENDS Partial
VAR speedVal : INT; END_VAR
    PROPERTY Speed : INT
        GET Speed := speedVal; END_GET
        SET speedVal := Speed; END_SET
    END_PROPERTY
END_FUNCTION_BLOCK
PROGRAM Main END_PROGRAM
`);
    expect(provided.success).toBe(true);
  });

  it("reads an intermediate read-only property and rejects a write-only one", () => {
    const readOnlyMiddle = compile(`
INTERFACE IBox
    PROPERTY Value : INT
    END_PROPERTY
END_INTERFACE
INTERFACE IReadBox
    PROPERTY Box : IBox
        GET
        END_GET
    END_PROPERTY
END_INTERFACE
FUNCTION_BLOCK Host
VAR
    itf : IReadBox;
END_VAR
    itf.Box.Value := 1;
END_FUNCTION_BLOCK
`);
    expect(readOnlyMiddle.success).toBe(true);

    const writeOnlyMiddle = compile(`
INTERFACE IBox
    PROPERTY Value : INT
    END_PROPERTY
END_INTERFACE
INTERFACE IWriteBox
    PROPERTY Box : IBox
        SET
        END_SET
    END_PROPERTY
END_INTERFACE
FUNCTION_BLOCK Host
VAR
    itf : IWriteBox;
END_VAR
    itf.Box.Value := 1;
END_FUNCTION_BLOCK
`);
    expect(writeOnlyMiddle.success).toBe(false);
    const message = writeOnlyMiddle.errors.map((e) => e.message).join("\n");
    expect(message).toContain("write-only");
    expect(message).toContain("BOX");
  });

  it("checks an interface input of a function-block call like an assignment", () => {
    const rejected = compile(`
INTERFACE IAct
    METHOD Go : INT
    END_METHOD
END_INTERFACE
FUNCTION_BLOCK Outsider
END_FUNCTION_BLOCK
FUNCTION_BLOCK Host
VAR_INPUT
    itf : IAct;
END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK Caller
VAR
    host : Host;
    bad : Outsider;
END_VAR
    host(itf := bad);
END_FUNCTION_BLOCK
`);
    expect(rejected.success).toBe(false);
    expect(rejected.errors.map((e) => e.message).join("\n")).toContain(
      "does not implement",
    );

    const accepted = compile(`
INTERFACE IAct
    METHOD Go : INT
    END_METHOD
END_INTERFACE
FUNCTION_BLOCK Provider IMPLEMENTS IAct
    METHOD Go : INT
        Go := 1;
    END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK Host
VAR_INPUT
    itf : IAct;
END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK Caller
VAR
    host : Host;
    good : Provider;
END_VAR
    host(itf := good);
END_FUNCTION_BLOCK
PROGRAM Main END_PROGRAM
`);
    expect(accepted.success).toBe(true);
  });

  it("wraps an interface inside ARRAY, POINTER, and REFERENCE", () => {
    const result = compile(`
INTERFACE IAct
    METHOD Go : INT
    END_METHOD
END_INTERFACE
FUNCTION_BLOCK Host
VAR
    arr : ARRAY[0..1] OF IAct;
    p : POINTER TO IAct;
    r : REFERENCE TO IAct;
    f : REF_TO IAct;
END_VAR
END_FUNCTION_BLOCK
PROGRAM Main END_PROGRAM
`);
    expect(result.success).toBe(true);
    expect(result.headerCode).toContain("Array1D<IEC_ITF<IACT>, 0, 1> ARR;");
    expect(result.headerCode).toContain("IEC_Ptr<IEC_ITF<IACT>> P;");
    expect(result.headerCode).toContain("IEC_REFERENCE_TO<IEC_ITF<IACT>> R;");
    expect(result.headerCode).toContain("IEC_REF_TO<IEC_ITF<IACT>> F;");
  });

  it("rejects an undefined property type on an interface", () => {
    const result = compile(`
INTERFACE IBad
    PROPERTY Speed : NoSuchType
    END_PROPERTY
END_INTERFACE
`);
    expect(result.success).toBe(false);
    expect(result.errors.map((e) => e.message).join("\n")).toContain(
      "Undefined type",
    );
  });
});

const DERIVED_SPEED_ST = `
FUNCTION_BLOCK Base
VAR
    speedVal : INT;
END_VAR
    PROPERTY Speed : INT
        GET
            Speed := speedVal;
        END_GET
        SET
            speedVal := Speed;
        END_SET
    END_PROPERTY
END_FUNCTION_BLOCK

FUNCTION_BLOCK Derived EXTENDS Base
END_FUNCTION_BLOCK

FUNCTION_BLOCK Host
VAR_OUTPUT
    y : INT;
END_VAR
VAR
    d : Derived;
END_VAR
    d.Speed := 1;
    y := d.Speed;
END_FUNCTION_BLOCK
`;

describe("Inherited function-block properties", () => {
  it("writes and reads a property inherited through EXTENDS via get_/set_", () => {
    const result = compile(DERIVED_SPEED_ST);
    expect(result.success).toBe(true);
    expect(result.cppCode).toContain("D.set_SPEED(1)");
    expect(result.cppCode).toContain("D.get_SPEED()");
    expect(result.cppCode).not.toContain("D.SPEED");
  });
});

describe.skipIf(!hasGpp)(
  "Inherited function-block properties (g++ -std=c++14, run)",
  () => {
    it("reads back the value written through the derived block", () => {
      const testST = `
TEST 'derived property round-trips'
  VAR host : Host; END_VAR
  host();
  ASSERT_EQ(host.y, 1);
END_TEST
`;
      const { stdout, exitCode } = runE2ETestPipeline({
        sourceST: DERIVED_SPEED_ST,
        testST,
        tempDirPrefix: "strucpp-iface-derived-speed-",
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain("1 test, 1 passed, 0 failed");
    });
  },
);
