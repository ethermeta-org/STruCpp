import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { formatDiagnostic } from "../../src/diagnostic-formatter.js";
import {
  claimInstructionId,
  debugStatementMapError,
  InstructionMapError,
  PLC_DEBUG_INSTR_ID_FIRST,
  PLC_DEBUG_INSTR_ID_NONE,
  PLC_DEBUG_MAX_INSTRUCTIONS,
} from "../../src/backend/debug-table-gen.js";

const SAMPLE = `
FUNCTION_BLOCK Callee
VAR
  x : INT;
END_VAR
x := 1;
END_FUNCTION_BLOCK

PROGRAM Main
VAR
  c : Callee;
  y : INT;
END_VAR
y := 2;
IF y > 0 THEN
  c();
END_IF
RETURN;
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 1);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION
`;

describe("instruction line map", () => {
  it("does not emit probes or statement rows when the switch is off", () => {
    const result = compile(SAMPLE, { emitDebugProbes: false });
    expect(result.success).toBe(true);
    expect(result.cppCode).not.toContain("plc_debug_probe");
    expect(result.cppCode).not.toContain("plc_debug_frame_enter");
    expect(result.debugMap?.statements).toBeUndefined();
    expect(result.debugMap?.pous).toBeUndefined();
    expect(result.debugMap?.leaves.length).toBeGreaterThan(0);
  });

  it("maps assignment, if, call, and return onto POU ids", () => {
    const result = compile(SAMPLE, { emitDebugProbes: true, fileName: "main.st" });
    expect(result.success).toBe(true);
    const map = result.debugMap!;
    const pous = map.pous ?? [];
    const statements = map.statements ?? [];
    expect(pous.map((n) => n.toUpperCase())).toEqual(["CALLEE", "MAIN"]);
    expect(debugStatementMapError(pous, statements)).toBeUndefined();
    expect(statements.length).toBe(5);
    expect(statements[0]?.instructionId).toBe(PLC_DEBUG_INSTR_ID_FIRST);
    for (const stmt of statements) {
      expect(stmt.instructionId).toBeGreaterThan(PLC_DEBUG_INSTR_ID_NONE);
      expect(stmt.instructionId).toBeLessThan(PLC_DEBUG_MAX_INSTRUCTIONS);
      expect(pous[stmt.pou_id]).toBeDefined();
      expect(stmt.file).toBe("main.st");
      expect(result.cppCode).toContain(`::plc_debug_probe(${stmt.instructionId}u);`);
    }
    const callee = statements.filter((s) => pous[s.pou_id]?.toUpperCase() === "CALLEE");
    const main = statements.filter((s) => pous[s.pou_id]?.toUpperCase() === "MAIN");
    expect(callee.length).toBe(1);
    expect(main.length).toBe(4);
    // SAMPLE: leading newline, so these are the source lines of assign / IF / call / RETURN.
    expect(callee[0]?.line).toBe(6);
    expect(main.map((s) => s.line)).toEqual([14, 15, 16, 18]);
    expect(result.cppCode).toContain("#ifndef UC_PLC_DEBUG_FRAME_GUARD");
    expect(result.cppCode).toContain("plc_debug_frame_enter");
    expect(result.cppCode).toContain("plc_debug_frame_leave");
    expect(result.cppCode).toContain("uc_plc_debug_frame{1u, 1u}");
    expect(result.cppCode).toContain("uc_plc_debug_frame{0u, 5u}");
  });

  it("fails the compile when the instruction id space is exhausted", () => {
    expect(() =>
      claimInstructionId(PLC_DEBUG_MAX_INSTRUCTIONS, {
        file: "big.st",
        line: 2,
        column: 1,
      }),
    ).toThrow(InstructionMapError);

    const body = Array.from({ length: PLC_DEBUG_MAX_INSTRUCTIONS }, () => "x := 1;").join("\n");
    const source = `PROGRAM Main\nVAR x : INT; END_VAR\n${body}\nEND_PROGRAM\n`;
    const result = compile(source, { emitDebugProbes: true, fileName: "big.st" });
    expect(result.success).toBe(false);
    expect(result.cppCode).not.toContain("plc_debug_probe");
    const err = result.errors[0]!;
    expect(err.file).toBe("big.st");
    const text = formatDiagnostic(err, new Map());
    expect(text.startsWith("big.st:")).toBe(true);
    expect(text).toContain(": error:");
    expect(text).toContain("instruction id exhausted");
  });
});
