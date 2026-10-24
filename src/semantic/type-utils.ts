// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Autonomy / OpenPLC Project
/**
 * STruC++ Shared Type Utilities
 *
 * Single source of truth for IEC 61131-3 type data, compatibility logic,
 * and member resolution. Pure functions and constant data — no classes, no state.
 *
 * Consolidates type information previously duplicated across:
 * - type-checker.ts (ELEMENTARY_TYPES, TYPE_CATEGORIES, areTypesCompatible)
 * - analyzer.ts (IEC_TYPE_BITS, resolveStructFieldType, resolveArrayElementType)
 * - codegen.ts (IEC_TYPE_BITS, IEC_TYPE_CAT, canImplicitWiden, resolveMemberType)
 */

import type {
  IECType,
  ElementaryType,
  ArrayType,
  CompilationUnit,
  ReferenceType,
  StructType,
  EnumType,
  FunctionBlockType,
} from "../frontend/ast.js";
import type { TypeConstraint } from "./std-function-registry.js";
import { IEC_BASE_TYPES, lookupBaseType } from "./iec-types-data.js";

/**
 * Map an IEC type name to its canonical spelling, collapsing aliases
 * (`TIME_OF_DAY` → `TOD`, `DATE_AND_TIME` → `DT`). Returns the input
 * unchanged for non-elementary names. Pure passthrough for upper-cased
 * canonical names (saves the registry lookup).
 *
 * Used by assignability / implicit-conversion checks so callers don't
 * have to remember to normalise on every comparison.
 */
export function canonicalElementaryName(name: string): string {
  return lookupBaseType(name)?.name ?? name.toUpperCase();
}

// =============================================================================
// Elementary Type Data
// =============================================================================

/**
 * Built-in elementary types as `ElementaryType` AST nodes, indexed by
 * canonical name AND every alias the parser accepts.
 *
 * Source of truth is `IEC_BASE_TYPES` in `iec-types-data.ts` (also
 * shipped as `libs/iec-types.json`). This map is just an AST-shaped
 * projection: each entry borrows the `bits` field as `sizeBits`
 * (the IEC logical width — `1` for BOOL, `8` for SINT, …, `0` for
 * variable-width strings).
 *
 * Each alias gets its own row pointing at an ElementaryType whose
 * name matches the alias spelling — so callers that read back
 * `.name` get the same string they looked up with.
 */
export const ELEMENTARY_TYPES: Record<string, ElementaryType> = (() => {
  const out: Record<string, ElementaryType> = {};
  for (const t of IEC_BASE_TYPES) {
    out[t.name] = { typeKind: "elementary", name: t.name, sizeBits: t.bits };
    for (const alias of t.aliases) {
      out[alias] = {
        typeKind: "elementary",
        name: alias,
        sizeBits: t.bits,
      };
    }
  }
  return out;
})();

// =============================================================================
// Type Categories
// =============================================================================

/**
 * Type category for IEC 61131-3 generic types.
 */
export type TypeCategory =
  | "ANY"
  | "ANY_DERIVED"
  | "ANY_ELEMENTARY"
  | "ANY_MAGNITUDE"
  | "ANY_NUM"
  | "ANY_REAL"
  | "ANY_INT"
  | "ANY_BIT"
  | "ANY_STRING"
  | "ANY_DATE";

/**
 * Map of type names to their categories.
 */
export const TYPE_CATEGORIES: Record<string, TypeCategory[]> = {
  BOOL: ["ANY", "ANY_ELEMENTARY", "ANY_BIT"],
  BYTE: ["ANY", "ANY_ELEMENTARY", "ANY_BIT"],
  WORD: ["ANY", "ANY_ELEMENTARY", "ANY_BIT"],
  DWORD: ["ANY", "ANY_ELEMENTARY", "ANY_BIT"],
  LWORD: ["ANY", "ANY_ELEMENTARY", "ANY_BIT"],
  __XWORD: ["ANY", "ANY_ELEMENTARY", "ANY_BIT"],
  SINT: ["ANY", "ANY_ELEMENTARY", "ANY_MAGNITUDE", "ANY_NUM", "ANY_INT"],
  INT: ["ANY", "ANY_ELEMENTARY", "ANY_MAGNITUDE", "ANY_NUM", "ANY_INT"],
  DINT: ["ANY", "ANY_ELEMENTARY", "ANY_MAGNITUDE", "ANY_NUM", "ANY_INT"],
  LINT: ["ANY", "ANY_ELEMENTARY", "ANY_MAGNITUDE", "ANY_NUM", "ANY_INT"],
  USINT: ["ANY", "ANY_ELEMENTARY", "ANY_MAGNITUDE", "ANY_NUM", "ANY_INT"],
  UINT: ["ANY", "ANY_ELEMENTARY", "ANY_MAGNITUDE", "ANY_NUM", "ANY_INT"],
  UDINT: ["ANY", "ANY_ELEMENTARY", "ANY_MAGNITUDE", "ANY_NUM", "ANY_INT"],
  ULINT: ["ANY", "ANY_ELEMENTARY", "ANY_MAGNITUDE", "ANY_NUM", "ANY_INT"],
  REAL: ["ANY", "ANY_ELEMENTARY", "ANY_MAGNITUDE", "ANY_NUM", "ANY_REAL"],
  LREAL: ["ANY", "ANY_ELEMENTARY", "ANY_MAGNITUDE", "ANY_NUM", "ANY_REAL"],
  TIME: ["ANY", "ANY_ELEMENTARY", "ANY_MAGNITUDE", "ANY_DATE"],
  DATE: ["ANY", "ANY_ELEMENTARY", "ANY_DATE"],
  TIME_OF_DAY: ["ANY", "ANY_ELEMENTARY", "ANY_DATE"],
  DATE_AND_TIME: ["ANY", "ANY_ELEMENTARY", "ANY_DATE"],
  STRING: ["ANY", "ANY_ELEMENTARY", "ANY_STRING"],
  WSTRING: ["ANY", "ANY_ELEMENTARY", "ANY_STRING"],
};

/**
 * Widening category groups for implicit conversion checks.
 * Types in the same group can be widened to a wider type in the same group.
 */
const WIDENING_CATEGORY: Record<string, string> = {
  BOOL: "BIT",
  BYTE: "BIT",
  WORD: "BIT",
  DWORD: "BIT",
  LWORD: "BIT",
  // __XWORD is a platform-width address type. We model it as a 64-bit
  // bit-string for category purposes (its sizeBits is 64); the explicit
  // free-conversion rule in isImplicitlyConvertible keeps address round-trips
  // (ADR()/REF_LINK() into integers/pointers) warning-free.
  __XWORD: "BIT",
  SINT: "SINT",
  INT: "SINT",
  DINT: "SINT",
  LINT: "SINT",
  USINT: "UINT",
  UINT: "UINT",
  UDINT: "UINT",
  ULINT: "UINT",
  REAL: "REAL",
  LREAL: "REAL",
};

// =============================================================================
// Type Data Accessors
// =============================================================================

/**
 * Get the bit width of an IEC elementary type by name.
 * Returns undefined for non-elementary or unknown types.
 */
export function getTypeBits(name: string): number | undefined {
  return ELEMENTARY_TYPES[name.toUpperCase()]?.sizeBits;
}

/** Types that support bit access (integer and bit types only — not REAL/LREAL). */
const BIT_ACCESSIBLE_TYPES: Record<string, number> = {
  BOOL: 1,
  BYTE: 8,
  WORD: 16,
  DWORD: 32,
  LWORD: 64,
  SINT: 8,
  INT: 16,
  DINT: 32,
  LINT: 64,
  USINT: 8,
  UINT: 16,
  UDINT: 32,
  ULINT: 64,
};

/**
 * Get the bit width for bit access validation.
 * Returns undefined for types that don't support bit access (REAL, STRING, etc.).
 */
export function getBitAccessWidth(name: string): number | undefined {
  return BIT_ACCESSIBLE_TYPES[name.toUpperCase()];
}

/**
 * Get the primary widening category for an IEC type.
 * Returns "BIT", "SINT", "UINT", or "REAL" — or undefined for non-elementary types.
 */
export function getTypeCategory(name: string): string | undefined {
  return WIDENING_CATEGORY[name.toUpperCase()];
}

// =============================================================================
// Category Matching
// =============================================================================

/**
 * Check if a type belongs to a given IEC type category.
 */
export function isTypeInCategory(
  type: IECType,
  category: TypeCategory,
): boolean {
  if (type.typeKind !== "elementary") {
    return category === "ANY" || category === "ANY_DERIVED";
  }

  const elemType = type as ElementaryType;
  const categories = TYPE_CATEGORIES[elemType.name];
  return categories?.includes(category) ?? false;
}

/** The IEC generic type-group names (ANY, ANY_BIT, ANY_NUM, ...). */
const GENERIC_TYPE_NAMES: ReadonlySet<string> = new Set([
  "ANY",
  "ANY_DERIVED",
  "ANY_ELEMENTARY",
  "ANY_MAGNITUDE",
  "ANY_NUM",
  "ANY_REAL",
  "ANY_INT",
  "ANY_BIT",
  "ANY_STRING",
  "ANY_DATE",
]);

/**
 * Spelling of the CODESYS `__QUERYINTERFACE(src, dest)` builtin. Declared
 * here so the semantic pass and codegen agree on the name; it is a
 * compiler builtin, not a registry std function.
 */
export const QUERY_INTERFACE_FN = "__QUERYINTERFACE";

/** Minimal POU shape collectImplementedInterfaces needs from an AST. */
export interface ImplementsAstSlice {
  functionBlocks: Array<{
    name: string;
    extends?: string;
    implements?: string[];
  }>;
  interfaces: Array<{ name: string; extends?: string[] }>;
}

/**
 * Every interface a function block type satisfies: its own IMPLEMENTS plus
 * the IMPLEMENTS of every FB on its EXTENDS chain, each expanded through
 * the interfaces' own EXTENDS chains (an implementation of a derived
 * interface also satisfies the parent interface). Names are upper-case.
 *
 * `undefined` when this compilation unit has no declaration of
 * `fbTypeName`. That is a library function block: the caller must not
 * report "does not implement". The generated `bind()` template constraint
 * is the check. An empty set means the block is declared here and the
 * IMPLEMENTS closure visible in this unit does not name any interface.
 * A parent that is not declared in this unit stops the walk; only the
 * visible closure is returned.
 */
export function collectImplementedInterfaces(
  ast: ImplementsAstSlice,
  fbTypeName: string,
): Set<string> | undefined {
  const fbsByUpper = new Map(
    ast.functionBlocks.map((fb) => [fb.name.toUpperCase(), fb]),
  );
  const start = fbTypeName.toUpperCase();
  if (!fbsByUpper.has(start)) return undefined;

  const implemented = new Set<string>();
  const ifacesByUpper = new Map(
    ast.interfaces.map((iface) => [iface.name.toUpperCase(), iface]),
  );

  // Expand one interface through its EXTENDS chain.
  const expandInterface = (ifaceName: string) => {
    const upper = ifaceName.toUpperCase();
    if (implemented.has(upper)) return;
    implemented.add(upper);
    const iface = ifacesByUpper.get(upper);
    for (const parent of iface?.extends ?? []) {
      expandInterface(parent);
    }
  };

  // Walk the FB EXTENDS chain, collecting each level's IMPLEMENTS.
  const visited = new Set<string>();
  let current: string | undefined = start;
  while (current && !visited.has(current)) {
    visited.add(current);
    const fb = fbsByUpper.get(current);
    if (!fb) break;
    for (const ifaceName of fb.implements ?? []) {
      expandInterface(ifaceName);
    }
    current = fb.extends?.toUpperCase();
  }
  return implemented;
}

/**
 * Whether `ifaceCandidateTypeName` is, or extends, `targetIfaceTypeName`
 * (both upper-case) — i.e. a reference of the candidate type may be
 * assigned to a variable of the target interface type.
 */
export function interfaceExtends(
  ast: ImplementsAstSlice,
  ifaceCandidateTypeName: string,
  targetIfaceTypeName: string,
): boolean {
  if (ifaceCandidateTypeName === targetIfaceTypeName) return true;
  const visited = new Set<string>();
  const queue = [ifaceCandidateTypeName];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);
    if (name === targetIfaceTypeName) return true;
    const iface = ast.interfaces.find((i) => i.name.toUpperCase() === name);
    for (const parent of iface?.extends ?? []) {
      queue.push(parent.toUpperCase());
    }
  }
  return false;
}

/** Type reference fields that distinguish one property type from another. */
export interface PropertyTypeRef {
  name: string;
  maxLength?: number | string;
  arrayDimensions?: Array<{ start: number; end: number }>;
  elementTypeName?: string;
  referenceKind?: string;
}

/** Minimal interface-property shape findInterfaceProperty needs. */
export interface InterfacePropertySlice {
  name: string;
  type: PropertyTypeRef;
  /** Present (possibly empty) = the interface declares the read direction. */
  getter?: unknown;
  /** Present (possibly empty) = the interface declares the write direction. */
  setter?: unknown;
}

/** Minimal AST shape findInterfaceProperty needs. */
export interface InterfacePropertyAstSlice {
  interfaces: Array<{
    name: string;
    extends?: string[];
    properties: InterfacePropertySlice[];
  }>;
}

/**
 * The property `propName` declared on `ifaceTypeName` or anywhere on its
 * EXTENDS chain. The first declaration in a breadth-first walk is the one
 * callers type against. Two declarations of the same name with a different
 * type or Get/Set direction are rejected by the analyzer
 * (`interfaceClosureClashes`); this lookup does not silently bless that
 * program. Undefined when the interface or the property is unknown —
 * including interfaces from pre-property dependency libraries, whose chunk
 * text carries no property declarations.
 */
export function findInterfaceProperty(
  ast: InterfacePropertyAstSlice | undefined,
  ifaceTypeName: string,
  propName: string,
): InterfacePropertySlice | undefined {
  if (!ast) return undefined;
  const propUpper = propName.toUpperCase();
  const visited = new Set<string>();
  const queue = [ifaceTypeName.toUpperCase()];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);
    const iface = ast.interfaces.find((i) => i.name.toUpperCase() === name);
    if (!iface) continue;
    const prop = iface.properties.find(
      (p) => p.name.toUpperCase() === propUpper,
    );
    if (prop) return prop;
    for (const parent of iface.extends ?? []) {
      queue.push(parent.toUpperCase());
    }
  }
  return undefined;
}

/**
 * Property types match when the type name, STRING/WSTRING length, array
 * element, and array bounds all match. Comparing `type.name` alone treats
 * `STRING(10)` and `STRING(20)`, and two `ARRAY OF` shapes, as the same type.
 */
export function propertyTypesEqual(
  a: PropertyTypeRef,
  b: PropertyTypeRef,
): boolean {
  if (a.name.toUpperCase() !== b.name.toUpperCase()) return false;
  const aRef =
    a.referenceKind && a.referenceKind !== "none" ? a.referenceKind : "";
  const bRef =
    b.referenceKind && b.referenceKind !== "none" ? b.referenceKind : "";
  if (aRef !== bRef) return false;
  const aLen = a.maxLength === undefined ? "" : String(a.maxLength);
  const bLen = b.maxLength === undefined ? "" : String(b.maxLength);
  if (aLen !== bLen) return false;
  const aElem = (a.elementTypeName ?? "").toUpperCase();
  const bElem = (b.elementTypeName ?? "").toUpperCase();
  if (aElem !== bElem) return false;
  const aDims = a.arrayDimensions ?? [];
  const bDims = b.arrayDimensions ?? [];
  if (aDims.length !== bDims.length) return false;
  for (let i = 0; i < aDims.length; i++) {
    if (
      aDims[i]!.start !== bDims[i]!.start ||
      aDims[i]!.end !== bDims[i]!.end
    ) {
      return false;
    }
  }
  return true;
}

/** Short type text for a property-signature diagnostic. */
export function formatPropertyType(t: PropertyTypeRef): string {
  if (t.arrayDimensions && t.arrayDimensions.length > 0) {
    const dims = t.arrayDimensions
      .map((d) => `${d.start}..${d.end}`)
      .join(", ");
    return `ARRAY[${dims}] OF ${t.elementTypeName ?? t.name}`;
  }
  if (t.maxLength !== undefined) return `${t.name}(${t.maxLength})`;
  return t.name;
}

/**
 * Get/Set direction from the accessor text. No accessors (or both) is
 * read-write; a lone GET is read-only; a lone SET is write-only.
 */
export function propertyDirectionLabel(prop: {
  getter?: unknown;
  setter?: unknown;
}): "read-write" | "read-only" | "write-only" {
  const canGet = prop.setter === undefined || prop.getter !== undefined;
  const canSet = prop.getter === undefined || prop.setter !== undefined;
  if (canGet && canSet) return "read-write";
  if (canGet) return "read-only";
  return "write-only";
}

/** One name collision inside an interface EXTENDS closure. */
export interface InterfaceClosureClash {
  kind: "method-property" | "property-signature";
  /** Upper-case member name. */
  name: string;
  /** Declaring interfaces and, for a property clash, each signature. */
  detail: string;
}

/**
 * Name collisions in one interface's EXTENDS closure.
 *
 * A method and a property cannot share a name. Two properties of the same
 * name must have the same type and the same Get/Set direction; the later
 * declaration is not dropped. Identical redeclarations (a diamond of the
 * same property) are not a clash.
 */
export function interfaceClosureClashes(
  ast: {
    interfaces: Array<{
      name: string;
      extends?: string[];
      methods: Array<{ name: string }>;
      properties: InterfacePropertySlice[];
    }>;
  },
  ifaceTypeName: string,
): InterfaceClosureClash[] {
  const byUpper = new Map(
    ast.interfaces.map((iface) => [iface.name.toUpperCase(), iface]),
  );
  const methods: Array<{ name: string; iface: string }> = [];
  const properties: Array<{ prop: InterfacePropertySlice; iface: string }> = [];
  const visited = new Set<string>();
  const queue = [ifaceTypeName.toUpperCase()];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);
    const iface = byUpper.get(name);
    if (!iface) continue;
    for (const method of iface.methods) {
      methods.push({ name: method.name.toUpperCase(), iface: name });
    }
    for (const prop of iface.properties) {
      properties.push({ prop, iface: name });
    }
    for (const parent of iface.extends ?? []) {
      queue.push(parent.toUpperCase());
    }
  }

  const clashes: InterfaceClosureClash[] = [];
  const methodIface = new Map<string, string>();
  for (const method of methods) {
    if (!methodIface.has(method.name))
      methodIface.set(method.name, method.iface);
  }
  const propsByName = new Map<
    string,
    Array<{ prop: InterfacePropertySlice; iface: string }>
  >();
  for (const entry of properties) {
    const key = entry.prop.name.toUpperCase();
    const list = propsByName.get(key) ?? [];
    list.push(entry);
    propsByName.set(key, list);
  }

  for (const [key, list] of propsByName) {
    const methodOn = methodIface.get(key);
    if (methodOn !== undefined) {
      clashes.push({
        kind: "method-property",
        name: key,
        detail: `method on '${methodOn}'`,
      });
    }
    const first = list[0]!;
    const differs = list.some(
      (entry) =>
        !propertyTypesEqual(first.prop.type, entry.prop.type) ||
        propertyDirectionLabel(first.prop) !==
          propertyDirectionLabel(entry.prop),
    );
    if (differs) {
      const detail = list
        .map(
          (entry) =>
            `'${entry.iface}' declares ${formatPropertyType(entry.prop.type)} ${propertyDirectionLabel(entry.prop)}`,
        )
        .join("; ");
      clashes.push({ kind: "property-signature", name: key, detail });
    }
  }
  return clashes;
}

/**
 * Whether a resolved type is one of the IEC generic type groups rather than a
 * concrete type. Overloaded standard functions are published with one of these
 * as their declared return type (e.g. NOT -> ANY_BIT); such a result must be
 * refined to a concrete type at the call site before it can be used.
 */
export function isGenericGroupType(type: IECType): boolean {
  return (
    type.typeKind === "elementary" &&
    GENERIC_TYPE_NAMES.has((type as ElementaryType).name.toUpperCase())
  );
}

/**
 * Check if a type name matches a StdFunctionRegistry TypeConstraint.
 */
export function matchesConstraint(
  typeName: string,
  constraint: TypeConstraint,
): boolean {
  const upper = typeName.toUpperCase();

  // "specific" constraints are checked by the caller against specificType
  if (constraint === "specific") return true;

  // "BOOL" is a special single-type constraint
  if (constraint === "BOOL") return upper === "BOOL";

  // Map constraint to TypeCategory and check membership
  const elem = ELEMENTARY_TYPES[upper];
  if (!elem) {
    // Non-elementary types match ANY and ANY_DERIVED
    return constraint === "ANY" || (constraint as string) === "ANY_DERIVED";
  }

  const categories = TYPE_CATEGORIES[upper];
  if (!categories) return constraint === "ANY";

  // TypeConstraint values map directly to TypeCategory values
  return categories.includes(constraint as TypeCategory);
}

// =============================================================================
// Type Compatibility
// =============================================================================

/**
 * Check if a source type can be assigned to a target type.
 * Allows same type, widening conversions within numeric types,
 * and cross-category promotions (BIT→INT, INT→REAL).
 */
export function isAssignable(target: IECType, source: IECType): boolean {
  // Same typeKind check
  if (target.typeKind !== source.typeKind) {
    // Allow elementary-to-elementary only
    if (target.typeKind !== "elementary" || source.typeKind !== "elementary") {
      return false;
    }
  }

  if (target.typeKind === "elementary" && source.typeKind === "elementary") {
    const t = target as ElementaryType;
    const s = source as ElementaryType;

    // Resolve aliases (TIME_OF_DAY ↔ TOD, DATE_AND_TIME ↔ DT) before
    // comparison so the parser/AST tag form doesn't matter.
    const tCanon = canonicalElementaryName(t.name);
    const sCanon = canonicalElementaryName(s.name);

    // Same canonical type is always assignable
    if (tCanon === sCanon) return true;

    // Use implicit conversion check (includes widening + cross-category)
    return isImplicitlyConvertible(sCanon, tCanon);
  }

  // For reference types, check referenced type compatibility
  if (target.typeKind === "reference" && source.typeKind === "reference") {
    const tRef = target as ReferenceType;
    const sRef = source as ReferenceType;
    return isAssignable(tRef.referencedType, sRef.referencedType);
  }

  // For other types (struct, array, FB), require exact match
  return JSON.stringify(target) === JSON.stringify(source);
}

/**
 * Check if a source type name can be implicitly converted to a target type name.
 * Covers CODESYS rules:
 * - Same-category widening (BYTE→DWORD, INT→DINT, REAL→LREAL)
 * - BIT→INT crossover (BYTE→INT, WORD→DINT)
 * - Integer/BIT→REAL promotion (INT→REAL, BYTE→REAL)
 */
export function isImplicitlyConvertible(
  source: string,
  target: string,
): boolean {
  const s = source.toUpperCase();
  const t = target.toUpperCase();
  if (s === t) return true;

  // __XWORD is a platform-width address type (CODESYS __XWORD semantics).
  // It is freely convertible — in either direction, without a narrowing
  // warning — with any bit-string or integer type, since ADR()/REF_LINK()
  // produce __XWORD and that address is routinely stored into BYTE/DWORD/...
  // and back. POINTER/REF assignments are handled separately by the caller.
  if (s === "__XWORD" || t === "__XWORD") {
    const other = s === "__XWORD" ? t : s;
    const otherCat = WIDENING_CATEGORY[other];
    if (otherCat === "BIT" || otherCat === "SINT" || otherCat === "UINT")
      return true;
  }

  const sBits = ELEMENTARY_TYPES[s]?.sizeBits;
  const tBits = ELEMENTARY_TYPES[t]?.sizeBits;
  const sCat = WIDENING_CATEGORY[s];
  const tCat = WIDENING_CATEGORY[t];

  if (sBits === undefined || tBits === undefined || !sCat || !tCat)
    return false;

  // Same category, wider target
  if (sCat === tCat && tBits >= sBits) return true;

  // BIT → signed/unsigned integer (CODESYS: BYTE→INT)
  if (sCat === "BIT" && (tCat === "SINT" || tCat === "UINT") && tBits >= sBits)
    return true;

  // Integer/unsigned → BIT (CODESYS: INT→DWORD when target is wide enough)
  if ((sCat === "SINT" || sCat === "UINT") && tCat === "BIT" && tBits >= sBits)
    return true;

  // Integer/unsigned/BIT → REAL promotion
  if (
    (sCat === "SINT" || sCat === "UINT" || sCat === "BIT") &&
    tCat === "REAL" &&
    tBits >= sBits
  )
    return true;

  return false;
}

/**
 * Check if converting from source to target is a narrowing conversion.
 * A narrowing conversion loses precision or changes the value range.
 */
export function isNarrowingConversion(target: string, source: string): boolean {
  const s = source.toUpperCase();
  const t = target.toUpperCase();
  if (s === t) return false;

  const sBits = ELEMENTARY_TYPES[s]?.sizeBits;
  const tBits = ELEMENTARY_TYPES[t]?.sizeBits;
  const sCat = WIDENING_CATEGORY[s];
  const tCat = WIDENING_CATEGORY[t];

  if (sBits === undefined || tBits === undefined || !sCat || !tCat)
    return false;

  // Same category, narrower target
  if (sCat === tCat && tBits < sBits) return true;

  // REAL → INT is always narrowing
  if (sCat === "REAL" && (tCat === "SINT" || tCat === "UINT" || tCat === "BIT"))
    return true;

  // Signed ↔ Unsigned of same width is narrowing (different value range)
  if (
    ((sCat === "SINT" && tCat === "UINT") ||
      (sCat === "UINT" && tCat === "SINT")) &&
    tBits <= sBits
  )
    return true;

  // INT → BIT is narrowing when target is smaller
  if ((sCat === "SINT" || sCat === "UINT") && tCat === "BIT" && tBits <= sBits)
    return true;

  // BIT → INT narrowing when target is smaller
  if (sCat === "BIT" && (tCat === "SINT" || tCat === "UINT") && tBits < sBits)
    return true;

  // INT/UINT → REAL is narrowing when target bits < source bits (e.g., ULINT→REAL)
  if (
    (sCat === "SINT" || sCat === "UINT" || sCat === "BIT") &&
    tCat === "REAL" &&
    tBits < sBits
  )
    return true;

  return false;
}

/**
 * Get the common (wider) type for binary expressions.
 * Returns undefined if the types are incompatible for arithmetic.
 */
export function getCommonType(a: IECType, b: IECType): IECType | undefined {
  if (a.typeKind !== "elementary" || b.typeKind !== "elementary") {
    return undefined;
  }

  const aElem = a as ElementaryType;
  const bElem = b as ElementaryType;

  // Same type
  if (aElem.name === bElem.name) return a;

  const aCat = WIDENING_CATEGORY[aElem.name];
  const bCat = WIDENING_CATEGORY[bElem.name];
  if (!aCat || !bCat) return undefined;

  // REAL types are wider than INT types
  if (aElem.name === "LREAL" || bElem.name === "LREAL") {
    return ELEMENTARY_TYPES["LREAL"];
  }
  if (aElem.name === "REAL" || bElem.name === "REAL") {
    return ELEMENTARY_TYPES["REAL"];
  }

  // Use canonical bit widths from ELEMENTARY_TYPES
  const aBits = ELEMENTARY_TYPES[aElem.name]?.sizeBits ?? aElem.sizeBits;
  const bBits = ELEMENTARY_TYPES[bElem.name]?.sizeBits ?? bElem.sizeBits;

  // Both must be in compatible numeric categories
  const aCategories = TYPE_CATEGORIES[aElem.name];
  const bCategories = TYPE_CATEGORIES[bElem.name];
  if (!aCategories || !bCategories) return undefined;

  const aIsNum = aCategories.includes("ANY_NUM");
  const bIsNum = bCategories.includes("ANY_NUM");
  const aIsBit = aCategories.includes("ANY_BIT");
  const bIsBit = bCategories.includes("ANY_BIT");

  // Both numeric → return the wider one
  if (aIsNum && bIsNum) {
    return aBits >= bBits ? a : b;
  }

  // BIT + NUM → promote BIT to the numeric type (or wider)
  if (aIsBit && bIsNum) return b;
  if (bIsBit && aIsNum) return a;

  // Both BIT → return wider
  if (aIsBit && bIsBit) {
    return aBits >= bBits ? a : b;
  }

  return undefined;
}

// =============================================================================
// Member Resolution
// =============================================================================

/**
 * Resolve the type of a struct or FB field by looking up the type definition in the AST.
 *
 * A function block member may be a variable or a property. The search walks
 * EXTENDS from the named block toward its parents. On each block a property
 * wins over a same-named variable, and the nearest block wins over a parent,
 * so `d.Speed` on a derived block is the inherited property rather than a
 * field the derived block does not declare.
 */
export function resolveFieldType(
  typeName: string,
  fieldName: string,
  ast: CompilationUnit,
): string | undefined {
  const typeUpper = typeName.toUpperCase();
  const fieldUpper = fieldName.toUpperCase();

  // Check struct type definitions
  for (const td of ast.types) {
    if (
      td.name.toUpperCase() === typeUpper &&
      td.definition.kind === "StructDefinition"
    ) {
      for (const field of td.definition.fields) {
        for (const name of field.names) {
          if (name.toUpperCase() === fieldUpper) return field.type.name;
        }
      }
    }
  }

  // FB variables and properties, nearest declaration on the EXTENDS chain.
  const fbByName = new Map(
    ast.functionBlocks.map((fb) => [fb.name.toUpperCase(), fb]),
  );
  if (fbByName.has(typeUpper)) {
    const visited = new Set<string>();
    let current: string | undefined = typeUpper;
    while (current && !visited.has(current)) {
      visited.add(current);
      const fb = fbByName.get(current);
      if (!fb) break;
      for (const prop of fb.properties) {
        if (prop.name.toUpperCase() === fieldUpper) return prop.type.name;
      }
      for (const block of fb.varBlocks) {
        for (const decl of block.declarations) {
          for (const name of decl.names) {
            if (name.toUpperCase() === fieldUpper) return decl.type.name;
          }
        }
      }
      current = fb.extends?.toUpperCase();
    }
    return undefined;
  }

  // Check programs (program instance member access)
  for (const prog of ast.programs) {
    if (prog.name.toUpperCase() === typeUpper) {
      for (const block of prog.varBlocks) {
        for (const decl of block.declarations) {
          for (const name of decl.names) {
            if (name.toUpperCase() === fieldUpper) return decl.type.name;
          }
        }
      }
      return undefined;
    }
  }

  return undefined;
}

/** `__VLA_<rank>D_<ElementType>`, the AST builder's name for an `ARRAY [*]`. */
const VLA_NAME = /^__VLA_\d+D_(.+)$/;

/**
 * Resolve the element type of an array type.
 * Handles __INLINE_ARRAY_* and __VLA_*D_* internal types, user-defined array
 * TYPE definitions, and aliases that eventually name one.
 */
export function resolveArrayElementType(
  typeName: string,
  ast: CompilationUnit,
  depth = 0,
): string | undefined {
  if (depth >= MAX_TYPE_ALIAS_DEPTH) return undefined;
  const typeUpper = typeName.toUpperCase();

  // Handle __INLINE_ARRAY_<ElementType> internal types
  if (typeUpper.startsWith("__INLINE_ARRAY_")) {
    return typeUpper.substring("__INLINE_ARRAY_".length);
  }

  const vla = VLA_NAME.exec(typeUpper);
  if (vla) return vla[1];

  // Check user-defined array type definitions
  for (const td of ast.types) {
    if (td.name.toUpperCase() !== typeUpper) continue;
    if (td.definition.kind === "ArrayDefinition") {
      return td.definition.elementType.name.toUpperCase();
    }
    if (td.definition.kind === "TypeReference") {
      // Alias — keep walking toward the underlying array, if any.
      return resolveArrayElementType(td.definition.name, ast, depth + 1);
    }
    return undefined;
  }

  return undefined;
}

/**
 * Evaluate a compile-time integer expression; undefined when it isn't one.
 *
 * Deliberately narrow — array bounds and similar declaration-time integers are
 * literals or a negated literal in practice, and anything else is better left
 * unresolved than guessed at.
 */
export function evalIntConst(e: unknown): number | undefined {
  if (e === null || e === undefined || typeof e !== "object") return undefined;
  const expr = e as {
    kind?: string;
    value?: unknown;
    operand?: unknown;
    operator?: string;
  };
  if (expr.kind === "LiteralExpression") {
    if (typeof expr.value === "number") return expr.value;
    if (typeof expr.value === "bigint") {
      const n = Number(expr.value);
      if (Number.isSafeInteger(n)) return n;
    }
  }
  if (expr.kind === "UnaryExpression" && expr.operator === "-") {
    const inner = evalIntConst(expr.operand);
    return inner === undefined ? undefined : -inner;
  }
  return undefined;
}

/** One declared array dimension; `null` when its extent isn't known statically. */
export type ArrayDimExtent = { start: number; end: number } | null;

/** The declared shape of an array type: its dimensions and element type name. */
export interface ArrayShape {
  /** One entry per dimension. `null` for a variable-length (`ARRAY[*]`) or
   *  non-constant bound — the rank is still known, the extent isn't. */
  dims: ArrayDimExtent[];
  elementTypeName: string;
}

/** Guard against a cyclic alias chain while resolving a type name. */
const MAX_TYPE_ALIAS_DEPTH = 32;

/**
 * Resolve the declared shape of an array-typed reference, following type
 * aliases. Returns undefined when the reference is not an array.
 *
 * Covers both spellings: an inline `ARRAY[…] OF T` (whose bounds the AST builder
 * has already resolved onto the TypeReference) and a named ARRAY type.
 */
export function resolveArrayShape(
  type: {
    name: string;
    arrayDimensions?: Array<{ start: number; end: number }>;
    elementTypeName?: string;
  },
  ast: CompilationUnit,
): ArrayShape | undefined {
  if (type.arrayDimensions && type.arrayDimensions.length > 0) {
    return {
      dims: type.arrayDimensions.map((d) => ({ start: d.start, end: d.end })),
      elementTypeName: type.elementTypeName ?? "",
    };
  }
  return resolveArrayShapeByName(type.name, ast);
}

/**
 * Resolve the declared shape of a named type, following alias chains.
 * Returns undefined when the name doesn't (transitively) name an array.
 */
export function resolveArrayShapeByName(
  typeName: string,
  ast: CompilationUnit,
  depth = 0,
): ArrayShape | undefined {
  if (depth >= MAX_TYPE_ALIAS_DEPTH) return undefined;
  const upper = typeName.toUpperCase();

  // Internal marker for an inline array whose bounds live on the declaration;
  // the rank isn't recoverable from the name alone.
  if (upper.startsWith("__INLINE_ARRAY_")) return undefined;

  for (const td of ast.types) {
    if (td.name.toUpperCase() !== upper) continue;
    const def = td.definition;
    if (def.kind === "ArrayDefinition") {
      return {
        dims: def.dimensions.map((d) => {
          if (d.isVariableLength) return null;
          const start = evalIntConst(d.start);
          const end = evalIntConst(d.end);
          return start === undefined || end === undefined
            ? null
            : { start, end };
        }),
        elementTypeName: def.elementType.name,
      };
    }
    if (def.kind === "TypeReference") {
      // Alias — keep walking toward the underlying array, if any.
      return resolveArrayShapeByName(def.name, ast, depth + 1);
    }
    return undefined;
  }
  return undefined;
}

/** Number of elements a dimension holds, or undefined when its extent is unknown. */
export function arrayDimSize(dim: ArrayDimExtent): number | undefined {
  if (!dim) return undefined;
  const size = dim.end - dim.start + 1;
  return size > 0 ? size : undefined;
}

/** Total element count across every dimension, or undefined if any is unknown. */
export function arrayTotalSize(dims: ArrayDimExtent[]): number | undefined {
  let total = 1;
  for (const d of dims) {
    const size = arrayDimSize(d);
    if (size === undefined) return undefined;
    total *= size;
  }
  return total;
}

// =============================================================================
// Display Helper
// =============================================================================

/**
 * Get a display name for an IECType.
 */
export function typeName(type: IECType): string {
  switch (type.typeKind) {
    case "elementary":
      return (type as ElementaryType).name;
    case "array":
      return "ARRAY";
    case "struct":
      return (type as StructType).name;
    case "enum":
      return (type as EnumType).name;
    case "reference":
      return `REF_TO ${typeName((type as ReferenceType).referencedType)}`;
    case "functionBlock":
      return (type as FunctionBlockType).name;
    default:
      return type.typeKind;
  }
}

// =============================================================================
// Enum Member Reverse Lookup
// =============================================================================

/**
 * Entry in the enum member reverse map.
 * `typeName` is the owning enum's original-case name, or `null` when the
 * member appears in more than one enum (ambiguous).
 * `conflictingTypes` lists all enum types that define this member (only
 * populated when ambiguous, for error messages).
 */
export interface EnumMemberEntry {
  typeName: string | null;
  conflictingTypes: string[];
}

/**
 * Build a reverse lookup map from enum member names to their owning enum type.
 * When a member name exists in multiple enum types the entry is marked
 * ambiguous (`typeName: null`) and `conflictingTypes` lists all owners.
 *
 * @param enumTypes Iterable of `{ name, members }` descriptors.
 *   `name` is the original-case enum type name; `members` are the
 *   original-case member names.
 * @returns Map keyed by uppercase member name.
 */
export function buildEnumMemberMap(
  enumTypes: Iterable<{ name: string; members: string[] }>,
): Map<string, EnumMemberEntry> {
  const map = new Map<string, EnumMemberEntry>();
  for (const enumType of enumTypes) {
    for (const member of enumType.members) {
      const key = member.toUpperCase();
      const existing = map.get(key);
      if (existing) {
        // Mark ambiguous and track all conflicting types
        existing.typeName = null;
        if (!existing.conflictingTypes.includes(enumType.name)) {
          existing.conflictingTypes.push(enumType.name);
        }
      } else {
        map.set(key, {
          typeName: enumType.name,
          conflictingTypes: [enumType.name],
        });
      }
    }
  }
  return map;
}

/**
 * Render an IECType as a short human-readable string for diagnostic
 * messages. Names the offending type without leaking internal field
 * structure: "INT", "STRUCT 'MyType'", "ARRAY", "REF_TO INT", etc.
 *
 * Falls back to the typeKind tag if the variant carries no name.
 */
export function describeType(t: IECType): string {
  switch (t.typeKind) {
    case "elementary":
      return (t as ElementaryType).name;
    case "struct":
      return `STRUCT '${(t as StructType).name}'`;
    case "enum":
      return `ENUM '${(t as EnumType).name}'`;
    case "functionBlock":
      return `FUNCTION_BLOCK '${(t as FunctionBlockType).name}'`;
    case "array":
      return `ARRAY OF ${describeType((t as ArrayType).elementType)}`;
    case "reference":
      return `REF_TO ${describeType((t as ReferenceType).referencedType)}`;
    default:
      return t.typeKind;
  }
}
