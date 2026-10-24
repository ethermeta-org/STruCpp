/**
 * Interface references and __QUERYINTERFACE (CBML 01/01).
 *
 * Covers the CODESYS interface semantics the CBML library needs:
 * - interface-typed variables are nullable references (IEC_ITF<T>), not values
 * - `itf := fb` binds when the FB (EXTENDS chain included) implements the
 *   interface; otherwise compilation fails naming both types
 * - `__QUERYINTERFACE(src, dest)` returns BOOL, binds dest on success, and
 *   unbinds dest on failure (the previous instance is released)
 * - a method call on an unbound reference yields the method's zero value
 *   instead of dereferencing null — the process must exit cleanly
 *
 * The E2E cases compile the generated C++ with g++ (-std=c++14) and run it.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import {
  QUERY_INTERFACE_FN,
  collectImplementedInterfaces,
} from "../../src/semantic/type-utils.js";
import { hasGpp, runE2ETestPipeline } from "./test-helpers.js";

/** The fixture from the CBML 01/01 ticket: assignment, query, unbound call. */
const FIXTURE_ST = `
INTERFACE IAct
    METHOD Go : INT
    END_METHOD
END_INTERFACE

INTERFACE IOther
    METHOD No : INT
    END_METHOD
END_INTERFACE

FUNCTION_BLOCK Provider IMPLEMENTS IAct
    METHOD Go : INT
        Go := 7;
    END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK Derived EXTENDS Provider
END_FUNCTION_BLOCK

FUNCTION_BLOCK OtherImpl IMPLEMENTS IOther
    METHOD No : INT
        No := 9;
    END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK Host
VAR_INPUT
    itf : IAct;
END_VAR
VAR_OUTPUT
    y : INT;
    qAct : BOOL;
    qOther : BOOL;
    qDerived : BOOL;
    destGo : INT;
    wrongNo : INT;
END_VAR
VAR
    src : Provider;
    dest : IAct;
    wrong : IOther;
    src2 : Derived;
    oimpl : OtherImpl;
END_VAR
    y := itf.Go();
    wrong := oimpl;
    qAct := ${QUERY_INTERFACE_FN}(src, dest);
    qOther := ${QUERY_INTERFACE_FN}(src, wrong);
    qDerived := ${QUERY_INTERFACE_FN}(src2, dest);
    destGo := dest.Go();
    wrongNo := wrong.No();
END_FUNCTION_BLOCK
`;

describe("Interface references (codegen shape)", () => {
  it("declares interface-typed members as IEC_ITF references", () => {
    const result = compile(FIXTURE_ST);
    expect(result.success).toBe(true);
    // VAR_INPUT member and VAR locals of interface type
    expect(result.headerCode).toContain("IEC_ITF<IACT> ITF;");
    expect(result.headerCode).toContain("IEC_ITF<IACT> DEST;");
    expect(result.headerCode).toContain("IEC_ITF<IOTHER> WRONG;");
  });

  it("emits guarded dispatch, bind, and one dynamic_cast per query", () => {
    const result = compile(FIXTURE_ST);
    expect(result.success).toBe(true);
    // Unbound call → zero value, never a null dereference
    expect(result.cppCode).toContain("ITF.get() != nullptr ? ITF->GO()");
    // Assignment binds rather than copies
    expect(result.cppCode).toContain("WRONG.bind(OIMPL)");
    // Query: dynamic_cast + rebind; failure binds nullptr
    expect(result.cppCode).toContain("dynamic_cast<IOTHER*>((&SRC))");
    expect(result.cppCode).toContain("dynamic_cast<IACT*>((&SRC2))");
  });
});

describe.skipIf(!hasGpp)("Interface references (g++ -std=c++14, run)", () => {
  it("binds, queries, and survives unbound calls", () => {
    const testST = `
TEST 'unbound interface call returns the zero value'
  VAR host : Host; END_VAR
  host();
  ASSERT_EQ(host.y, 0);
END_TEST

TEST 'assignment binds the provider and dispatches through the reference'
  VAR host : Host; END_VAR
  VAR p : Provider; END_VAR
  host(itf := p);
  host();
  ASSERT_EQ(host.y, 7);
END_TEST

TEST 'query binds implemented interfaces across the EXTENDS chain'
  VAR host : Host; END_VAR
  host();
  ASSERT_TRUE(host.qAct);
  ASSERT_TRUE(host.qDerived);
  ASSERT_EQ(host.destGo, 7);
END_TEST

TEST 'failed query returns false and releases the old binding'
  VAR host : Host; END_VAR
  host();
  ASSERT_FALSE(host.qOther);
  ASSERT_EQ(host.wrongNo, 0);
END_TEST
`;
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: FIXTURE_ST,
      testST,
      tempDirPrefix: "strucpp-iface-query-",
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("4 tests, 4 passed, 0 failed");
  });
});

describe("Interface assignment and query diagnostics", () => {
  it("rejects assigning an FB that does not implement the interface, naming both types", () => {
    const result = compile(`
INTERFACE IAct
    METHOD Go : INT
    END_METHOD
END_INTERFACE
INTERFACE IOther
    METHOD No : INT
    END_METHOD
END_INTERFACE
FUNCTION_BLOCK Provider IMPLEMENTS IAct
    METHOD Go : INT
        Go := 7;
    END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK Outsider IMPLEMENTS IOther
    METHOD No : INT
        No := 1;
    END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK Host
VAR
    itf : IAct;
    bad : Outsider;
END_VAR
    itf := bad;
END_FUNCTION_BLOCK
`);
    expect(result.success).toBe(false);
    const message = result.errors.map((e) => e.message).join("\n");
    expect(message).toContain("OUTSIDER");
    expect(message).toContain("IACT");
    expect(message).toContain("does not implement");
  });

  it("rejects a scalar assignment to an interface variable", () => {
    const result = compile(`
INTERFACE IAct
    METHOD Go : INT
    END_METHOD
END_INTERFACE
FUNCTION_BLOCK Host
VAR
    itf : IAct;
END_VAR
    itf := 5;
END_FUNCTION_BLOCK
`);
    expect(result.success).toBe(false);
    expect(result.errors.map((e) => e.message).join("\n")).toContain("IACT");
  });

  it("rejects __QUERYINTERFACE with a non-interface destination", () => {
    const result = compile(`
INTERFACE IAct
    METHOD Go : INT
    END_METHOD
END_INTERFACE
FUNCTION_BLOCK Provider IMPLEMENTS IAct
    METHOD Go : INT
        Go := 7;
    END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK Host
VAR
    src : Provider;
    n : INT;
    ok : BOOL;
END_VAR
    ok := ${QUERY_INTERFACE_FN}(src, n);
END_FUNCTION_BLOCK
`);
    expect(result.success).toBe(false);
    expect(result.errors.map((e) => e.message).join("\n")).toContain(
      "destination must be an interface variable",
    );
  });

  it("rejects __QUERYINTERFACE with the wrong argument count", () => {
    const result = compile(`
INTERFACE IAct
    METHOD Go : INT
    END_METHOD
END_INTERFACE
FUNCTION_BLOCK Provider IMPLEMENTS IAct
    METHOD Go : INT
        Go := 7;
    END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK Host
VAR
    src : Provider;
    dest : IAct;
    ok : BOOL;
END_VAR
    ok := ${QUERY_INTERFACE_FN}(src);
END_FUNCTION_BLOCK
`);
    expect(result.success).toBe(false);
    expect(result.errors.map((e) => e.message).join("\n")).toContain(
      "exactly two arguments",
    );
  });

  it("requires an FB implementing an interface to provide inherited methods too", () => {
    // IParent's method is inherited by IChild; implementing IChild alone
    // without Go must fail.
    const result = compile(`
INTERFACE IParent
    METHOD Go : INT
    END_METHOD
END_INTERFACE
INTERFACE IChild EXTENDS IParent
    METHOD Stop : INT
    END_METHOD
END_INTERFACE
FUNCTION_BLOCK Partial IMPLEMENTS IChild
    METHOD Stop : INT
        Stop := 1;
    END_METHOD
END_FUNCTION_BLOCK
`);
    expect(result.success).toBe(false);
    expect(result.errors.map((e) => e.message).join("\n")).toContain("GO");
  });

  it("rejects __QUERYINTERFACE when an argument is not a variable", () => {
    const result = compile(`
INTERFACE IAct
    METHOD Go : INT
    END_METHOD
END_INTERFACE
FUNCTION_BLOCK Provider IMPLEMENTS IAct
    METHOD Go : INT
        Go := 7;
    END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK Host
VAR
    src : Provider;
    dest : IAct;
    ok : BOOL;
END_VAR
    ok := ${QUERY_INTERFACE_FN}(src.Go(), dest);
    ok := ${QUERY_INTERFACE_FN}(src, 1);
END_FUNCTION_BLOCK
`);
    expect(result.success).toBe(false);
    const message = result.errors.map((e) => e.message).join("\n");
    expect(message).toContain("source must be a variable");
    expect(message).toContain("destination must be an interface variable");
    expect(result.cppCode).toBe("");
  });

  it("does not report a missing implementation for a function block declared outside this unit", () => {
    expect(
      collectImplementedInterfaces(
        { functionBlocks: [], interfaces: [{ name: "IACT" }] },
        "LIBFB",
      ),
    ).toBeUndefined();
    const declared = collectImplementedInterfaces(
      {
        functionBlocks: [{ name: "MINE" }],
        interfaces: [{ name: "IACT" }],
      },
      "MINE",
    );
    expect(declared?.has("IACT")).toBe(false);
  });
});

const DIAMOND_ST = `
INTERFACE IBase
    METHOD Id : INT
    END_METHOD
END_INTERFACE

INTERFACE I1 EXTENDS IBase
END_INTERFACE

INTERFACE I2 EXTENDS IBase
END_INTERFACE

FUNCTION_BLOCK Diamond IMPLEMENTS I1, I2
    METHOD Id : INT
        Id := 4;
    END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK Host
VAR_OUTPUT
    q : BOOL;
    gotQuery : INT;
    gotAssign : INT;
    qCase1 : BOOL;
    qCase2 : BOOL;
END_VAR
VAR
    fb : Diamond;
    ibase : IBase;
    assigned : IBase;
    i : INT := 1;
END_VAR
    q := ${QUERY_INTERFACE_FN}(fb, ibase);
    gotQuery := ibase.Id();
    assigned := fb;
    gotAssign := assigned.Id();
    CASE i OF
        1: qCase1 := ${QUERY_INTERFACE_FN}(fb, ibase);
        2: qCase2 := ${QUERY_INTERFACE_FN}(fb, ibase);
    END_CASE
END_FUNCTION_BLOCK
`;

const WHILE_QUERY_ST = `
INTERFACE IAct
    METHOD Go : INT
    END_METHOD
END_INTERFACE

FUNCTION_BLOCK Provider IMPLEMENTS IAct
    METHOD Go : INT
        Go := 7;
    END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK Host
VAR_OUTPUT
    hits : INT;
END_VAR
VAR
    good : Provider;
    holder : IAct;
    empty : IAct;
    dest : IAct;
    i : INT;
END_VAR
    holder := good;
    WHILE i < 2 AND ${QUERY_INTERFACE_FN}(holder, dest) DO
        hits := hits + dest.Go();
        holder := empty;
        i := i + 1;
    END_WHILE
END_FUNCTION_BLOCK
`;

describe("Interface query evaluation (codegen shape)", () => {
  it("returns an interface by value and guards the call", () => {
    const result = compile(`
INTERFACE IAct
    METHOD Go : INT
    END_METHOD
    METHOD Next : IAct
    END_METHOD
END_INTERFACE
FUNCTION_BLOCK Provider IMPLEMENTS IAct
    METHOD Go : INT
        Go := 3;
    END_METHOD
    METHOD Next : IAct
    END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK Host
VAR
    itf : IAct;
    nxt : IAct;
END_VAR
    nxt := itf.Next();
END_FUNCTION_BLOCK
PROGRAM Main END_PROGRAM
`);
    expect(result.success).toBe(true);
    expect(result.headerCode).toContain("virtual IEC_ITF<IACT> NEXT() = 0;");
    expect(result.headerCode).toContain("virtual IEC_ITF<IACT> NEXT();");
    expect(result.cppCode).toContain(
      "ITF.get() != nullptr ? ITF->NEXT() : IEC_ITF<IACT>()",
    );
    expect(result.cppCode).toContain("IEC_ITF<IACT> NEXT_result;");
    expect(result.cppCode).toContain("NXT.bind(");
  });

  it("queries inside an immediately-invoked lambda", () => {
    const result = compile(DIAMOND_ST);
    expect(result.success).toBe(true);
    expect(result.headerCode).toContain("class I1 : virtual public IBASE {");
    expect(result.headerCode).toContain("class I2 : virtual public IBASE {");
    expect(result.headerCode).toContain(
      "class DIAMOND : virtual public I1, virtual public I2 {",
    );
    expect(result.cppCode).toContain("([&]()");
    expect(result.cppCode).toContain("dynamic_cast<IBASE*>");
  });
});

describe.skipIf(!hasGpp)(
  "Interface diamond and repeated query (g++ -std=c++14, run)",
  () => {
    it("queries IBase through a diamond and assigns the function block", () => {
      const testST = `
TEST 'diamond query and assignment both see IBase'
  VAR host : Host; END_VAR
  host();
  ASSERT_TRUE(host.q);
  ASSERT_EQ(host.gotQuery, 4);
  ASSERT_EQ(host.gotAssign, 4);
  ASSERT_TRUE(host.qCase1);
END_TEST
`;
      const { stdout, exitCode } = runE2ETestPipeline({
        sourceST: DIAMOND_ST,
        testST,
        tempDirPrefix: "strucpp-iface-diamond-",
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain("1 test, 1 passed, 0 failed");
    });

    it("evaluates __QUERYINTERFACE on every WHILE iteration", () => {
      const testST = `
TEST 'second iteration sees the unbound holder'
  VAR host : Host; END_VAR
  host();
  ASSERT_EQ(host.hits, 7);
END_TEST
`;
      const { stdout, exitCode } = runE2ETestPipeline({
        sourceST: WHILE_QUERY_ST,
        testST,
        tempDirPrefix: "strucpp-iface-while-query-",
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain("1 test, 1 passed, 0 failed");
    });
  },
);
