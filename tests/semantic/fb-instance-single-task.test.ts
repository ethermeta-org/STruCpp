/**
 * stlib-contract 21: one MC_* / ETC_* instance, one PROGRAM, one PLC task.
 *
 * Two tasks calling one mailbox writer is a double writer. The check is a
 * compile error, not a warning. Two instances of one PROGRAM type are two
 * objects and stay legal.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { compileStlib } from "../../src/library/library-compiler.js";

function errorsOf(source: string): string[] {
  return compile(source).errors.map((e) => e.message);
}

function hasSingleTaskError(messages: string[]): boolean {
  return messages.some((m) =>
    m.includes("only one PROGRAM and one PLC task"),
  );
}

const MC_POWER = `
  FUNCTION_BLOCK MC_Power
    VAR_INPUT Enable : BOOL; END_VAR
    VAR_OUTPUT Status : BOOL; END_VAR
  END_FUNCTION_BLOCK
`;

const USER_WRAP = `
  FUNCTION_BLOCK FB_AxisCtrl
    VAR
      pwr : MC_Power;
    END_VAR
    pwr(Enable := TRUE);
  END_FUNCTION_BLOCK
`;

describe("motion FB instance single task", () => {
  it("rejects one global MC_Power called from two tasks", () => {
    const messages = errorsOf(`
      ${MC_POWER}
      CONFIGURATION Config0
        VAR_GLOBAL
          shared : MC_Power;
        END_VAR
        RESOURCE Res0 ON PLC
          TASK FastTask(INTERVAL := T#1ms, PRIORITY := 0);
          TASK SlowTask(INTERVAL := T#10ms, PRIORITY := 1);
          PROGRAM INST0 WITH FastTask : FastProg;
          PROGRAM INST1 WITH SlowTask : SlowProg;
        END_RESOURCE
      END_CONFIGURATION
      PROGRAM FastProg
        VAR_EXTERNAL shared : MC_Power; END_VAR
        shared(Enable := TRUE);
      END_PROGRAM
      PROGRAM SlowProg
        VAR_EXTERNAL shared : MC_Power; END_VAR
        shared(Enable := FALSE);
      END_PROGRAM
    `);
    expect(hasSingleTaskError(messages)).toBe(true);
    expect(messages.some((m) => m.toUpperCase().includes("SHARED"))).toBe(true);
  });

  it("rejects a user FB that holds MC_Power when the wrapper is global", () => {
    const messages = errorsOf(`
      ${MC_POWER}
      ${USER_WRAP}
      CONFIGURATION Config0
        VAR_GLOBAL
          ctrl : FB_AxisCtrl;
        END_VAR
        RESOURCE Res0 ON PLC
          TASK FastTask(INTERVAL := T#1ms, PRIORITY := 0);
          TASK SlowTask(INTERVAL := T#10ms, PRIORITY := 1);
          PROGRAM INST0 WITH FastTask : FastProg;
          PROGRAM INST1 WITH SlowTask : SlowProg;
        END_RESOURCE
      END_CONFIGURATION
      PROGRAM FastProg
        VAR_EXTERNAL ctrl : FB_AxisCtrl; END_VAR
        ctrl();
      END_PROGRAM
      PROGRAM SlowProg
        VAR_EXTERNAL ctrl : FB_AxisCtrl; END_VAR
        ctrl();
      END_PROGRAM
    `);
    expect(messages.some((m) => m.toUpperCase().includes("FB_AXISCTRL"))).toBe(
      true,
    );
    expect(hasSingleTaskError(messages)).toBe(true);
  });

  it("rejects two programs on the same task sharing one MC_Power", () => {
    const messages = errorsOf(`
      ${MC_POWER}
      CONFIGURATION Config0
        VAR_GLOBAL
          shared : MC_Power;
        END_VAR
        RESOURCE Res0 ON PLC
          TASK MainTask(INTERVAL := T#1ms, PRIORITY := 0);
          PROGRAM INST0 WITH MainTask : FastProg;
          PROGRAM INST1 WITH MainTask : SlowProg;
        END_RESOURCE
      END_CONFIGURATION
      PROGRAM FastProg
        VAR_EXTERNAL shared : MC_Power; END_VAR
        shared(Enable := TRUE);
      END_PROGRAM
      PROGRAM SlowProg
        VAR_EXTERNAL shared : MC_Power; END_VAR
        shared(Enable := FALSE);
      END_PROGRAM
    `);
    expect(hasSingleTaskError(messages)).toBe(true);
  });

  it("allows one program on one task to own a local MC_Power", () => {
    const result = compile(`
      ${MC_POWER}
      PROGRAM Main
        VAR
          pwr : MC_Power;
        END_VAR
        pwr(Enable := TRUE);
      END_PROGRAM
      CONFIGURATION Config0
        RESOURCE Res0 ON PLC
          TASK MainTask(INTERVAL := T#1ms, PRIORITY := 0);
          PROGRAM INST0 WITH MainTask : Main;
        END_RESOURCE
      END_CONFIGURATION
    `);
    expect(result.errors.map((e) => e.message)).toEqual([]);
    expect(result.success).toBe(true);
  });

  it("allows two instances of one PROGRAM type, each with its own MC_Power", () => {
    const result = compile(`
      ${MC_POWER}
      PROGRAM Main
        VAR
          pwr : MC_Power;
        END_VAR
        pwr(Enable := TRUE);
      END_PROGRAM
      CONFIGURATION Config0
        RESOURCE Res0 ON PLC
          TASK FastTask(INTERVAL := T#1ms, PRIORITY := 0);
          TASK SlowTask(INTERVAL := T#10ms, PRIORITY := 1);
          PROGRAM INST0 WITH FastTask : Main;
          PROGRAM INST1 WITH SlowTask : Main;
        END_RESOURCE
      END_CONFIGURATION
    `);
    expect(result.errors.map((e) => e.message)).toEqual([]);
    expect(result.success).toBe(true);
  });

  it("does not apply the motion rule to a non-motion FB global", () => {
    const source = `
      FUNCTION_BLOCK FB_Plain
        VAR n : INT; END_VAR
        n := n + 1;
      END_FUNCTION_BLOCK
      CONFIGURATION Config0
        VAR_GLOBAL
          plain : FB_Plain;
        END_VAR
        RESOURCE Res0 ON PLC
          TASK FastTask(INTERVAL := T#1ms, PRIORITY := 0);
          TASK SlowTask(INTERVAL := T#10ms, PRIORITY := 1);
          PROGRAM INST0 WITH FastTask : FastProg;
          PROGRAM INST1 WITH SlowTask : SlowProg;
        END_RESOURCE
      END_CONFIGURATION
      PROGRAM FastProg
        VAR_EXTERNAL plain : FB_Plain; END_VAR
        plain();
      END_PROGRAM
      PROGRAM SlowProg
        VAR_EXTERNAL plain : FB_Plain; END_VAR
        plain();
      END_PROGRAM
    `;
    let messages: string[] = [];
    try {
      messages = errorsOf(source);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      expect(text.includes("only one PROGRAM and one PLC task")).toBe(false);
      expect(text.includes("not yet supported")).toBe(true);
      return;
    }
    expect(hasSingleTaskError(messages)).toBe(false);
  });

  it("rejects a file-level MC.MC_Power shared by two tasks", () => {
    const mc = compileStlib(
      [{
        fileName: "mc.st",
        source: `
          FUNCTION_BLOCK MC_Power
            VAR_INPUT Enable : BOOL; END_VAR
            VAR_OUTPUT Status : BOOL; END_VAR
          END_FUNCTION_BLOCK
        `,
      }],
      { name: "mc", version: "1.0.0", namespace: "MC" },
    );
    expect(mc.success).toBe(true);
    const messages = compile(
      `
        VAR_GLOBAL
          shared : MC.MC_Power;
        END_VAR
        PROGRAM FastProg
          VAR_EXTERNAL shared : MC.MC_Power; END_VAR
          shared(Enable := TRUE);
        END_PROGRAM
        PROGRAM SlowProg
          VAR_EXTERNAL shared : MC.MC_Power; END_VAR
          shared(Enable := FALSE);
        END_PROGRAM
        CONFIGURATION Config0
          RESOURCE Res0 ON PLC
            TASK FastTask(INTERVAL := T#1ms, PRIORITY := 0);
            TASK SlowTask(INTERVAL := T#10ms, PRIORITY := 1);
            PROGRAM INST0 WITH FastTask : FastProg;
            PROGRAM INST1 WITH SlowTask : SlowProg;
          END_RESOURCE
        END_CONFIGURATION
      `,
      { libraries: [mc.archive!] },
    ).errors.map((e) => e.message);
    expect(hasSingleTaskError(messages)).toBe(true);
  });

  it("rejects an MC_Power reached through another FB body", () => {
    const messages = errorsOf(`
      ${MC_POWER}
      VAR_GLOBAL
        shared : MC_Power;
      END_VAR
      FUNCTION_BLOCK FB_Use
        VAR_EXTERNAL shared : MC_Power; END_VAR
        shared(Enable := TRUE);
      END_FUNCTION_BLOCK
      PROGRAM FastProg
        VAR u : FB_Use; END_VAR
        u();
      END_PROGRAM
      PROGRAM SlowProg
        VAR u : FB_Use; END_VAR
        u();
      END_PROGRAM
      CONFIGURATION Config0
        RESOURCE Res0 ON PLC
          TASK FastTask(INTERVAL := T#1ms, PRIORITY := 0);
          TASK SlowTask(INTERVAL := T#10ms, PRIORITY := 1);
          PROGRAM INST0 WITH FastTask : FastProg;
          PROGRAM INST1 WITH SlowTask : SlowProg;
        END_RESOURCE
      END_CONFIGURATION
    `);
    expect(hasSingleTaskError(messages)).toBe(true);
  });

  it("rejects two instances of one program calling one file-level MC_Power", () => {
    const messages = errorsOf(`
      ${MC_POWER}
      VAR_GLOBAL
        shared : MC_Power;
      END_VAR
      PROGRAM Main
        VAR_EXTERNAL shared : MC_Power; END_VAR
        shared(Enable := TRUE);
      END_PROGRAM
      CONFIGURATION Config0
        RESOURCE Res0 ON PLC
          TASK MainTask(INTERVAL := T#1ms, PRIORITY := 0);
          PROGRAM INST0 WITH MainTask : Main;
          PROGRAM INST1 WITH MainTask : Main;
        END_RESOURCE
      END_CONFIGURATION
    `);
    expect(hasSingleTaskError(messages)).toBe(true);
  });

  it("rejects SUPER^() when the base FB calls a file-level MC_Power", () => {
    const messages = errorsOf(`
      ${MC_POWER}
      VAR_GLOBAL
        shared : MC_Power;
      END_VAR
      FUNCTION_BLOCK FB_Base
        VAR_EXTERNAL shared : MC_Power; END_VAR
        shared(Enable := TRUE);
      END_FUNCTION_BLOCK
      FUNCTION_BLOCK FB_Child EXTENDS FB_Base
        SUPER^();
      END_FUNCTION_BLOCK
      PROGRAM FastProg
        VAR u : FB_Child; END_VAR
        u();
      END_PROGRAM
      PROGRAM SlowProg
        VAR u : FB_Child; END_VAR
        u();
      END_PROGRAM
      CONFIGURATION Config0
        RESOURCE Res0 ON PLC
          TASK FastTask(INTERVAL := T#1ms, PRIORITY := 0);
          TASK SlowTask(INTERVAL := T#10ms, PRIORITY := 1);
          PROGRAM INST0 WITH FastTask : FastProg;
          PROGRAM INST1 WITH SlowTask : SlowProg;
        END_RESOURCE
      END_CONFIGURATION
    `);
    expect(hasSingleTaskError(messages)).toBe(true);
  });

  it("rejects an array of a child FB whose base calls a file-level MC_Power", () => {
    const messages = errorsOf(`
      ${MC_POWER}
      VAR_GLOBAL
        shared : MC_Power;
      END_VAR
      FUNCTION_BLOCK FB_Base
        VAR_EXTERNAL shared : MC_Power; END_VAR
        shared(Enable := TRUE);
      END_FUNCTION_BLOCK
      FUNCTION_BLOCK FB_Child EXTENDS FB_Base
        SUPER^();
      END_FUNCTION_BLOCK
      PROGRAM FastProg
        VAR u : ARRAY[1..2] OF FB_Child; END_VAR
        u[1]();
      END_PROGRAM
      PROGRAM SlowProg
        VAR u : ARRAY[1..2] OF FB_Child; END_VAR
        u[1]();
      END_PROGRAM
      CONFIGURATION Config0
        RESOURCE Res0 ON PLC
          TASK FastTask(INTERVAL := T#1ms, PRIORITY := 0);
          TASK SlowTask(INTERVAL := T#10ms, PRIORITY := 1);
          PROGRAM INST0 WITH FastTask : FastProg;
          PROGRAM INST1 WITH SlowTask : SlowProg;
        END_RESOURCE
      END_CONFIGURATION
    `);
    expect(hasSingleTaskError(messages)).toBe(true);
  });

  it("rejects a type alias and a struct field that reach a file-level MC_Power", () => {
    const alias = errorsOf(`
      ${MC_POWER}
      VAR_GLOBAL
        shared : MC_Power;
      END_VAR
      FUNCTION_BLOCK FB_Base
        VAR_EXTERNAL shared : MC_Power; END_VAR
        shared(Enable := TRUE);
      END_FUNCTION_BLOCK
      FUNCTION_BLOCK FB_Child EXTENDS FB_Base
        SUPER^();
      END_FUNCTION_BLOCK
      TYPE Kids : ARRAY[1..2] OF FB_Child; END_TYPE
      PROGRAM FastProg
        VAR u : Kids; END_VAR
        u[1]();
      END_PROGRAM
      PROGRAM SlowProg
        VAR u : Kids; END_VAR
        u[1]();
      END_PROGRAM
      CONFIGURATION Config0
        RESOURCE Res0 ON PLC
          TASK FastTask(INTERVAL := T#1ms, PRIORITY := 0);
          TASK SlowTask(INTERVAL := T#10ms, PRIORITY := 1);
          PROGRAM INST0 WITH FastTask : FastProg;
          PROGRAM INST1 WITH SlowTask : SlowProg;
        END_RESOURCE
      END_CONFIGURATION
    `);
    expect(hasSingleTaskError(alias)).toBe(true);
    const packed = errorsOf(`
      ${MC_POWER}
      VAR_GLOBAL
        shared : MC_Power;
      END_VAR
      FUNCTION_BLOCK FB_Base
        VAR_EXTERNAL shared : MC_Power; END_VAR
        shared(Enable := TRUE);
      END_FUNCTION_BLOCK
      FUNCTION_BLOCK FB_Child EXTENDS FB_Base
        SUPER^();
      END_FUNCTION_BLOCK
      TYPE Pack : STRUCT
        u : FB_Child;
      END_STRUCT
      END_TYPE
      PROGRAM FastProg
        VAR p : Pack; END_VAR
        p.u();
      END_PROGRAM
      PROGRAM SlowProg
        VAR p : Pack; END_VAR
        p.u();
      END_PROGRAM
      CONFIGURATION Config0
        RESOURCE Res0 ON PLC
          TASK FastTask(INTERVAL := T#1ms, PRIORITY := 0);
          TASK SlowTask(INTERVAL := T#10ms, PRIORITY := 1);
          PROGRAM INST0 WITH FastTask : FastProg;
          PROGRAM INST1 WITH SlowTask : SlowProg;
        END_RESOURCE
      END_CONFIGURATION
    `);
    expect(hasSingleTaskError(packed)).toBe(true);
  });

  it("rejects a file-level ETC_GetMasterState shared by two tasks", () => {
    const messages = errorsOf(`
      FUNCTION_BLOCK ETC_GetMasterState
        VAR_INPUT Enable : BOOL; END_VAR
        VAR_OUTPUT Valid : BOOL; END_VAR
      END_FUNCTION_BLOCK
      VAR_GLOBAL
        shared : ETC_GetMasterState;
      END_VAR
      PROGRAM FastProg
        VAR_EXTERNAL shared : ETC_GetMasterState; END_VAR
        shared(Enable := TRUE);
      END_PROGRAM
      PROGRAM SlowProg
        VAR_EXTERNAL shared : ETC_GetMasterState; END_VAR
        shared(Enable := FALSE);
      END_PROGRAM
      CONFIGURATION Config0
        RESOURCE Res0 ON PLC
          TASK FastTask(INTERVAL := T#1ms, PRIORITY := 0);
          TASK SlowTask(INTERVAL := T#10ms, PRIORITY := 1);
          PROGRAM INST0 WITH FastTask : FastProg;
          PROGRAM INST1 WITH SlowTask : SlowProg;
        END_RESOURCE
      END_CONFIGURATION
    `);
    expect(hasSingleTaskError(messages)).toBe(true);
  });

  it("rejects the same program instance name on two tasks", () => {
    const messages = errorsOf(`
      PROGRAM Main
        VAR n : INT; END_VAR
        n := n + 1;
      END_PROGRAM
      CONFIGURATION Config0
        RESOURCE Res0 ON PLC
          TASK FastTask(INTERVAL := T#1ms, PRIORITY := 0);
          TASK SlowTask(INTERVAL := T#10ms, PRIORITY := 1);
          PROGRAM INST0 WITH FastTask : Main;
          PROGRAM INST0 WITH SlowTask : Main;
        END_RESOURCE
      END_CONFIGURATION
    `);
    expect(messages.some((m) => m.includes("bound more than once"))).toBe(true);
    expect(messages.some((m) => m.includes("INST0"))).toBe(true);
  });

  it("allows the same program instance name in two configurations", () => {
    const messages = errorsOf(`
      PROGRAM Main
        VAR n : INT; END_VAR
        n := n + 1;
      END_PROGRAM
      CONFIGURATION ConfigA
        RESOURCE Res0 ON PLC
          TASK MainTask(INTERVAL := T#1ms, PRIORITY := 0);
          PROGRAM INST0 WITH MainTask : Main;
        END_RESOURCE
      END_CONFIGURATION
      CONFIGURATION ConfigB
        RESOURCE Res0 ON PLC
          TASK MainTask(INTERVAL := T#1ms, PRIORITY := 0);
          PROGRAM INST0 WITH MainTask : Main;
        END_RESOURCE
      END_CONFIGURATION
    `);
    expect(messages.some((m) => m.includes("bound more than once"))).toBe(false);
  });

  it("rejects an alias, a struct field, and a base-class VAR of MC_Power", () => {
    const alias = errorsOf(`
      ${MC_POWER}
      TYPE PwrAlias : MC_Power; END_TYPE
      VAR_GLOBAL shared : PwrAlias; END_VAR
      PROGRAM FastProg
        VAR_EXTERNAL shared : PwrAlias; END_VAR
        shared(Enable := TRUE);
      END_PROGRAM
      PROGRAM SlowProg
        VAR_EXTERNAL shared : PwrAlias; END_VAR
        shared(Enable := FALSE);
      END_PROGRAM
      CONFIGURATION Config0
        RESOURCE Res0 ON PLC
          TASK FastTask(INTERVAL := T#1ms, PRIORITY := 0);
          TASK SlowTask(INTERVAL := T#10ms, PRIORITY := 1);
          PROGRAM INST0 WITH FastTask : FastProg;
          PROGRAM INST1 WITH SlowTask : SlowProg;
        END_RESOURCE
      END_CONFIGURATION
    `);
    expect(hasSingleTaskError(alias)).toBe(true);

    const packed = errorsOf(`
      ${MC_POWER}
      TYPE Pack : STRUCT u : MC_Power; END_STRUCT END_TYPE
      VAR_GLOBAL shared : Pack; END_VAR
      PROGRAM FastProg
        VAR_EXTERNAL shared : Pack; END_VAR
        shared.u(Enable := TRUE);
      END_PROGRAM
      PROGRAM SlowProg
        VAR_EXTERNAL shared : Pack; END_VAR
        shared.u(Enable := FALSE);
      END_PROGRAM
      CONFIGURATION Config0
        RESOURCE Res0 ON PLC
          TASK FastTask(INTERVAL := T#1ms, PRIORITY := 0);
          TASK SlowTask(INTERVAL := T#10ms, PRIORITY := 1);
          PROGRAM INST0 WITH FastTask : FastProg;
          PROGRAM INST1 WITH SlowTask : SlowProg;
        END_RESOURCE
      END_CONFIGURATION
    `);
    expect(hasSingleTaskError(packed)).toBe(true);

    const derived = errorsOf(`
      ${MC_POWER}
      FUNCTION_BLOCK FB_Base
        VAR pwr : MC_Power; END_VAR
        pwr(Enable := TRUE);
      END_FUNCTION_BLOCK
      FUNCTION_BLOCK FB_Child EXTENDS FB_Base
      END_FUNCTION_BLOCK
      VAR_GLOBAL shared : FB_Child; END_VAR
      PROGRAM FastProg
        VAR_EXTERNAL shared : FB_Child; END_VAR
        shared();
      END_PROGRAM
      PROGRAM SlowProg
        VAR_EXTERNAL shared : FB_Child; END_VAR
        shared();
      END_PROGRAM
      CONFIGURATION Config0
        RESOURCE Res0 ON PLC
          TASK FastTask(INTERVAL := T#1ms, PRIORITY := 0);
          TASK SlowTask(INTERVAL := T#10ms, PRIORITY := 1);
          PROGRAM INST0 WITH FastTask : FastProg;
          PROGRAM INST1 WITH SlowTask : SlowProg;
        END_RESOURCE
      END_CONFIGURATION
    `);
    expect(hasSingleTaskError(derived)).toBe(true);
  });

  it("does not treat an MC_ struct or a VAR_IN_OUT as owned storage", () => {
    const track = errorsOf(`
      TYPE MC_TRACK : STRUCT n : INT; END_STRUCT END_TYPE
      VAR_GLOBAL shared : MC_TRACK; END_VAR
      PROGRAM FastProg
        VAR_EXTERNAL shared : MC_TRACK; END_VAR
        shared.n := 1;
      END_PROGRAM
      PROGRAM SlowProg
        VAR_EXTERNAL shared : MC_TRACK; END_VAR
        shared.n := 2;
      END_PROGRAM
      CONFIGURATION Config0
        RESOURCE Res0 ON PLC
          TASK FastTask(INTERVAL := T#1ms, PRIORITY := 0);
          TASK SlowTask(INTERVAL := T#10ms, PRIORITY := 1);
          PROGRAM INST0 WITH FastTask : FastProg;
          PROGRAM INST1 WITH SlowTask : SlowProg;
        END_RESOURCE
      END_CONFIGURATION
    `);
    expect(hasSingleTaskError(track)).toBe(false);

    const inout = errorsOf(`
      ${MC_POWER}
      FUNCTION_BLOCK FB_Wrap
        VAR_IN_OUT pwr : MC_Power; END_VAR
        pwr(Enable := TRUE);
      END_FUNCTION_BLOCK
      VAR_GLOBAL shared : FB_Wrap; END_VAR
      PROGRAM FastProg
        VAR_EXTERNAL shared : FB_Wrap; END_VAR
        shared();
      END_PROGRAM
      PROGRAM SlowProg
        VAR_EXTERNAL shared : FB_Wrap; END_VAR
        shared();
      END_PROGRAM
      CONFIGURATION Config0
        RESOURCE Res0 ON PLC
          TASK FastTask(INTERVAL := T#1ms, PRIORITY := 0);
          TASK SlowTask(INTERVAL := T#10ms, PRIORITY := 1);
          PROGRAM INST0 WITH FastTask : FastProg;
          PROGRAM INST1 WITH SlowTask : SlowProg;
        END_RESOURCE
      END_CONFIGURATION
    `);
    expect(hasSingleTaskError(inout)).toBe(false);
  });

  it("rejects an inline array of a user FB that stores MC_Power", () => {
    const messages = errorsOf(`
      ${MC_POWER}
      FUNCTION_BLOCK FB_Wrap
        VAR pwr : MC_Power; END_VAR
        pwr(Enable := TRUE);
      END_FUNCTION_BLOCK
      VAR_GLOBAL shared : ARRAY[1..2] OF FB_Wrap; END_VAR
      PROGRAM FastProg
        VAR_EXTERNAL shared : ARRAY[1..2] OF FB_Wrap; END_VAR
        shared[1]();
      END_PROGRAM
      PROGRAM SlowProg
        VAR_EXTERNAL shared : ARRAY[1..2] OF FB_Wrap; END_VAR
        shared[1]();
      END_PROGRAM
      CONFIGURATION Config0
        RESOURCE Res0 ON PLC
          TASK FastTask(INTERVAL := T#1ms, PRIORITY := 0);
          TASK SlowTask(INTERVAL := T#10ms, PRIORITY := 1);
          PROGRAM INST0 WITH FastTask : FastProg;
          PROGRAM INST1 WITH SlowTask : SlowProg;
        END_RESOURCE
      END_CONFIGURATION
    `);
    expect(hasSingleTaskError(messages)).toBe(true);
  });

  it("rejects one global SMC_ControlAxisByPos called from two tasks", () => {
    const messages = errorsOf(`
      FUNCTION_BLOCK SMC_ControlAxisByPos
        VAR_INPUT bEnable : BOOL; END_VAR
      END_FUNCTION_BLOCK
      VAR_GLOBAL shared : SMC_ControlAxisByPos; END_VAR
      PROGRAM FastProg
        VAR_EXTERNAL shared : SMC_ControlAxisByPos; END_VAR
        shared(bEnable := TRUE);
      END_PROGRAM
      PROGRAM SlowProg
        VAR_EXTERNAL shared : SMC_ControlAxisByPos; END_VAR
        shared(bEnable := FALSE);
      END_PROGRAM
      CONFIGURATION Config0
        RESOURCE Res0 ON PLC
          TASK FastTask(INTERVAL := T#1ms, PRIORITY := 0);
          TASK SlowTask(INTERVAL := T#10ms, PRIORITY := 1);
          PROGRAM INST0 WITH FastTask : FastProg;
          PROGRAM INST1 WITH SlowTask : SlowProg;
        END_RESOURCE
      END_CONFIGURATION
    `);
    expect(hasSingleTaskError(messages)).toBe(true);
  });

  it("rejects SUPER^() when the library base stores MC_Power", () => {
    const lib = compileStlib(
      [{
        fileName: "base.st",
        source: `
          FUNCTION_BLOCK MC_Power
            VAR_INPUT Enable : BOOL; END_VAR
          END_FUNCTION_BLOCK
          FUNCTION_BLOCK FB_Base
            VAR
              pwr : MC_Power;
            END_VAR
            pwr(Enable := TRUE);
          END_FUNCTION_BLOCK
        `,
      }],
      { name: "motion", version: "1.0.0" },
    );
    expect(lib.success).toBe(true);
    const messages = compile(
      `
        FUNCTION_BLOCK FB_Child EXTENDS FB_Base
          SUPER^();
        END_FUNCTION_BLOCK
        VAR_GLOBAL shared : FB_Child; END_VAR
        PROGRAM FastProg
          VAR_EXTERNAL shared : FB_Child; END_VAR
          shared();
        END_PROGRAM
        PROGRAM SlowProg
          VAR_EXTERNAL shared : FB_Child; END_VAR
          shared();
        END_PROGRAM
        CONFIGURATION Config0
          RESOURCE Res0 ON PLC
            TASK FastTask(INTERVAL := T#1ms, PRIORITY := 0);
            TASK SlowTask(INTERVAL := T#10ms, PRIORITY := 1);
            PROGRAM INST0 WITH FastTask : FastProg;
            PROGRAM INST1 WITH SlowTask : SlowProg;
          END_RESOURCE
        END_CONFIGURATION
      `,
      { libraries: [lib.archive!] },
    ).errors.map((e) => e.message);
    expect(hasSingleTaskError(messages)).toBe(true);
  });

  it("does not treat a library MC_TRACK struct as a motion FB", () => {
    const lib = compileStlib(
      [{
        fileName: "track.st",
        source: `
          TYPE MC_TRACK : STRUCT
            n : INT;
          END_STRUCT END_TYPE
        `,
      }],
      { name: "motion", version: "1.0.0", namespace: "MC" },
    );
    expect(lib.success).toBe(true);
    const messages = compile(
      `
        VAR_GLOBAL shared : MC.MC_TRACK; END_VAR
        PROGRAM FastProg
          VAR_EXTERNAL shared : MC.MC_TRACK; END_VAR
          shared.n := 1;
        END_PROGRAM
        PROGRAM SlowProg
          VAR_EXTERNAL shared : MC.MC_TRACK; END_VAR
          shared.n := 2;
        END_PROGRAM
        CONFIGURATION Config0
          RESOURCE Res0 ON PLC
            TASK MainTask(INTERVAL := T#1ms, PRIORITY := 0);
            PROGRAM INST0 WITH MainTask : FastProg;
            PROGRAM INST1 WITH MainTask : SlowProg;
          END_RESOURCE
        END_CONFIGURATION
      `,
      { libraries: [lib.archive!] },
    ).errors.map((e) => e.message);
    expect(hasSingleTaskError(messages)).toBe(false);
  });

  it("rejects a qualified function-block call that has no instance", () => {
    const mc = compileStlib(
      [{
        fileName: "mc.st",
        source: `
          FUNCTION_BLOCK MC_Power
            VAR_INPUT Enable : BOOL; END_VAR
            VAR_IN_OUT Axis : INT; END_VAR
          END_FUNCTION_BLOCK
        `,
      }],
      { name: "mc", version: "1.0.0", namespace: "MC" },
    );
    expect(mc.success).toBe(true);
    const messages = compile(
      `
        PROGRAM Main
          VAR ax : INT; END_VAR
          MC.MC_Power(Enable := TRUE, Axis := ax);
        END_PROGRAM
      `,
      { libraries: [mc.archive!] },
    ).errors.map((e) => e.message);
    expect(messages.some((m) => m.includes("must be called on an instance"))).toBe(
      true,
    );
  });

  it("copies a positional VAR_IN_OUT back to the caller", () => {
    const result = compile(`
      FUNCTION_BLOCK MC_Power
        VAR_INPUT Enable : BOOL; END_VAR
        VAR_IN_OUT Axis : INT; END_VAR
      END_FUNCTION_BLOCK
      PROGRAM Main
        VAR
          pwr : MC_Power;
          ax : INT;
        END_VAR
        pwr(TRUE, ax);
      END_PROGRAM
    `);
    expect(result.errors).toEqual([]);
    expect(result.cppCode).toContain("AX = PWR.AXIS");
    expect(result.cppCode).toContain("PWR.AXIS = AX");
  });
});
