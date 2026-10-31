const JSON_CONTROL_LIMIT = 0x20;
const JSON_SPACE_CODE = 0x20;
const JSON_TAB_CODE = 0x09;
const JSON_LINE_FEED_CODE = 0x0a;
const JSON_CARRIAGE_RETURN_CODE = 0x0d;
const JSON_BOM_CODE = 0xfeff;
const JSON_UNICODE_ESCAPE_LENGTH = 4;
const HEX_RADIX = 16;
const JSON_INDENT_STEP = 2;
const FIRST_LIST_ENTRY_INDEX = 0;
const AUTO_MODE_ENTRY_INDEX = FIRST_LIST_ENTRY_INDEX + 1;
const AUTO_MODE_PATH_DEPTH = 2;
const AUTO_MODE_DEFAULTS_ENTRY = "$defaults";
const HASH_BIT_WIDTH = 64;
const HASH_HEX_LENGTH = HASH_BIT_WIDTH / 4;
const HASH_OFFSET_BASIS = 14695981039346656037n;
const HASH_PRIME = 1099511628211n;
const HASH_MASK = (1n << BigInt(HASH_BIT_WIDTH)) - 1n;
const NUMBER_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/;
const UNICODE_ESCAPE_PATTERN = /^[0-9A-Fa-f]{4}$/;
const IDENTIFIER_BOUNDARY_PATTERN = /[A-Za-z0-9_.-]/;
const JSON_WHITESPACE_PATTERN = /^[ \t\r\n]*$/;

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

export type JsonObject = {
  [key: string]: JsonValue;
};

export type DesiredValueSetting = {
  id: string;
  feature: string;
  kind: "value";
  path: readonly string[];
  value: JsonValue;
};

export type DesiredListEntrySetting = {
  id: string;
  feature: string;
  kind: "list-entry";
  path: readonly string[];
  value: string;
};

export type DesiredHookSetting = {
  id: string;
  feature: string;
  kind: "hook";
  event: string;
  matcher: string;
  scriptName: string;
  value: JsonObject;
};

export type DesiredInstallDefault = {
  id: string;
  kind: "install-default";
  path: readonly string[];
  value: JsonValue;
};

export type DesiredSettingEntry =
  | DesiredValueSetting
  | DesiredListEntrySetting
  | DesiredHookSetting
  | DesiredInstallDefault;

export type ValueOwnershipRecord = {
  id: string;
  feature: string;
  kind: "value";
  path: string[];
  value: JsonValue;
  owned?: boolean;
  seenHash?: string;
};

export type ListEntryOwnershipRecord = {
  id: string;
  feature: string;
  kind: "list-entry";
  path: string[];
  value: string;
  owned?: boolean;
  seenHash?: string;
  index?: number;
  arrayLength?: number;
  beforeValue?: JsonValue;
  afterValue?: JsonValue;
  containerCreated?: boolean;
};

export type HookOwnershipRecord = {
  id: string;
  feature: string;
  kind: "hook";
  event: string;
  matcher: string;
  scriptName: string;
  value: JsonObject;
  owned?: boolean;
  seenHash?: string;
  index?: number;
  groupIndex?: number;
  arrayLength?: number;
  beforeValue?: JsonValue;
  afterValue?: JsonValue;
};

export type SettingsOwnershipRecord =
  | ValueOwnershipRecord
  | ListEntryOwnershipRecord
  | HookOwnershipRecord;

export type SettingsMergeRequest = {
  currentText: string;
  desiredEntries: readonly DesiredSettingEntry[];
  ownershipRecords: readonly unknown[];
  mode: "install" | "apply";
  backupPath: string;
};

export type SettingKeptEvent = {
  type: "setting-kept";
  level: "warn";
  text: string;
};

export type SettingsBackupValue = {
  id: string;
  location: string[];
  value: JsonValue;
};

export type SettingsMergeSuccess = {
  ok: true;
  text: string;
  records: SettingsOwnershipRecord[];
  events: SettingKeptEvent[];
  backupValues: SettingsBackupValue[];
  changed: boolean;
};

export type SettingsMergeFailure = {
  ok: false;
  error: string;
};

export type SettingsMergeResult = SettingsMergeSuccess | SettingsMergeFailure;

type JsonProperty = {
  key: string;
  keyStart: number;
  keyEnd: number;
  value: JsonNode;
};

type JsonObjectNode = {
  kind: "object";
  start: number;
  end: number;
  closeStart: number;
  properties: JsonProperty[];
};

type JsonArrayNode = {
  kind: "array";
  start: number;
  end: number;
  closeStart: number;
  items: JsonNode[];
};

type JsonStringNode = {
  kind: "string";
  start: number;
  end: number;
  value: string;
};

type JsonNumberNode = {
  kind: "number";
  start: number;
  end: number;
  value: number;
};

type JsonBooleanNode = {
  kind: "boolean";
  start: number;
  end: number;
  value: boolean;
};

type JsonNullNode = {
  kind: "null";
  start: number;
  end: number;
};

type JsonNode =
  | JsonObjectNode
  | JsonArrayNode
  | JsonStringNode
  | JsonNumberNode
  | JsonBooleanNode
  | JsonNullNode;

type ParseDocumentResult =
  | {
      ok: true;
      root: JsonObjectNode;
    }
  | {
      ok: false;
      error: string;
    };

type PathLookup =
  | {
      kind: "found";
      parent: JsonObjectNode;
      property: JsonProperty;
    }
  | {
      kind: "missing";
      parent: JsonObjectNode;
      key: string;
      missingIndex: number;
    }
  | {
      kind: "blocked";
      node: JsonNode;
      prefix: string[];
    };

type ListObservation =
  | {
      kind: "unchanged";
      index: number;
    }
  | {
      kind: "changed";
      index: number;
      value: JsonValue;
    }
  | {
      kind: "missing";
    }
  | {
      kind: "ambiguous";
      value: JsonValue;
    };

type HookMatch = {
  event: string;
  matcher: string;
  groupIndex: number;
  entryIndex: number;
  hooksNode: JsonArrayNode;
  entryNode: JsonObjectNode;
  value: JsonObject;
};

type MergeWork = {
  text: string;
  events: SettingKeptEvent[];
  backupValues: SettingsBackupValue[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isAutoModeDefaultsEntry = (path: readonly string[], value: string): boolean =>
  path.length === AUTO_MODE_PATH_DEPTH && path[0] === "autoMode" && value === AUTO_MODE_DEFAULTS_ENTRY;

const isUnknownArray = (value: unknown): value is unknown[] => Array.isArray(value);

const isJsonValue = (value: unknown, ancestors = new Set<object>()): value is JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (isUnknownArray(value)) {
    if (ancestors.has(value)) {
      return false;
    }
    ancestors.add(value);
    const valid = value.every((item) => isJsonValue(item, ancestors));
    ancestors.delete(value);
    return valid;
  }

  if (!isRecord(value) || ancestors.has(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  ancestors.add(value);
  const valid = Object.keys(value).every((key) => isJsonValue(value[key], ancestors));
  ancestors.delete(value);
  return valid;
};

const isJsonObject = (value: unknown): value is JsonObject =>
  isRecord(value) && isJsonValue(value);

const isStringArray = (value: unknown): value is string[] =>
  isUnknownArray(value) && value.every((item) => typeof item === "string");

const isOptionalString = (record: Record<string, unknown>, key: string): boolean =>
  record[key] === undefined || typeof record[key] === "string";

const isOptionalBoolean = (record: Record<string, unknown>, key: string): boolean =>
  record[key] === undefined || typeof record[key] === "boolean";

const isOptionalIndex = (record: Record<string, unknown>, key: string): boolean => {
  const value = record[key];
  return value === undefined || (typeof value === "number" && Number.isInteger(value) && value >= 0);
};

const isOptionalJsonValue = (record: Record<string, unknown>, key: string): boolean =>
  record[key] === undefined || isJsonValue(record[key]);

const hasPath = (record: Record<string, unknown>): boolean =>
  isStringArray(record.path) && record.path.length > 0;

const isDesiredSetting = (value: unknown): value is DesiredSettingEntry => {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) {
    return false;
  }

  if (value.kind === "install-default") {
    return hasPath(value) && isJsonValue(value.value);
  }

  if (typeof value.feature !== "string" || value.feature.length === 0) {
    return false;
  }

  if (value.kind === "value") {
    return hasPath(value) && isJsonValue(value.value);
  }

  if (value.kind === "list-entry") {
    return hasPath(value) && typeof value.value === "string";
  }

  // Hook entries are identified by event, matcher and script name; they have no path.
  return value.kind === "hook"
    && typeof value.event === "string"
    && value.event.length > 0
    && typeof value.matcher === "string"
    && typeof value.scriptName === "string"
    && value.scriptName.length > 0
    && isJsonObject(value.value);
};

const normalizeOwnershipRecord = (value: unknown): SettingsOwnershipRecord | undefined => {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || value.id.length === 0
    || typeof value.feature !== "string"
    || value.feature.length === 0
    || typeof value.kind !== "string"
    || !isOptionalBoolean(value, "owned")
    || !isOptionalString(value, "seenHash")) {
    return undefined;
  }

  if (value.kind === "value"
    && isStringArray(value.path)
    && value.path.length > 0
    && isJsonValue(value.value)) {
    return {
      id: value.id,
      feature: value.feature,
      kind: "value",
      path: [...value.path],
      value: cloneJsonValue(value.value),
      owned: value.owned !== false,
      ...(typeof value.seenHash === "string" ? { seenHash: value.seenHash } : {}),
    };
  }

  if (value.kind === "list-entry"
    && isStringArray(value.path)
    && value.path.length > 0
    && typeof value.value === "string"
    && isOptionalIndex(value, "index")
    && isOptionalIndex(value, "arrayLength")
    && isOptionalJsonValue(value, "beforeValue")
    && isOptionalJsonValue(value, "afterValue")
    && isOptionalBoolean(value, "containerCreated")) {
    return {
      id: value.id,
      feature: value.feature,
      kind: "list-entry",
      path: [...value.path],
      value: value.value,
      owned: value.owned !== false,
      ...(typeof value.seenHash === "string" ? { seenHash: value.seenHash } : {}),
      ...(typeof value.index === "number" ? { index: value.index } : {}),
      ...(typeof value.arrayLength === "number" ? { arrayLength: value.arrayLength } : {}),
      ...(isJsonValue(value.beforeValue) ? { beforeValue: cloneJsonValue(value.beforeValue) } : {}),
      ...(isJsonValue(value.afterValue) ? { afterValue: cloneJsonValue(value.afterValue) } : {}),
      ...(typeof value.containerCreated === "boolean" ? { containerCreated: value.containerCreated } : {}),
    };
  }

  if (value.kind === "hook"
    && typeof value.event === "string"
    && value.event.length > 0
    && typeof value.matcher === "string"
    && typeof value.scriptName === "string"
    && value.scriptName.length > 0
    && isJsonObject(value.value)
    && isOptionalIndex(value, "index")
    && isOptionalIndex(value, "groupIndex")
    && isOptionalIndex(value, "arrayLength")
    && isOptionalJsonValue(value, "beforeValue")
    && isOptionalJsonValue(value, "afterValue")) {
    return {
      id: value.id,
      feature: value.feature,
      kind: "hook",
      event: value.event,
      matcher: value.matcher,
      scriptName: value.scriptName,
      value: cloneJsonObject(value.value),
      owned: value.owned !== false,
      ...(typeof value.seenHash === "string" ? { seenHash: value.seenHash } : {}),
      ...(typeof value.index === "number" ? { index: value.index } : {}),
      ...(typeof value.groupIndex === "number" ? { groupIndex: value.groupIndex } : {}),
      ...(typeof value.arrayLength === "number" ? { arrayLength: value.arrayLength } : {}),
      ...(isJsonValue(value.beforeValue) ? { beforeValue: cloneJsonValue(value.beforeValue) } : {}),
      ...(isJsonValue(value.afterValue) ? { afterValue: cloneJsonValue(value.afterValue) } : {}),
    };
  }

  return undefined;
};

const cloneJsonValue = (value: JsonValue): JsonValue => {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (isUnknownArray(value)) {
    return value.map((item) => cloneJsonValue(item));
  }

  const copy: JsonObject = {};
  for (const key of Object.keys(value)) {
    Object.defineProperty(copy, key, {
      value: cloneJsonValue(value[key]),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return copy;
};

const cloneJsonObject = (value: JsonObject): JsonObject => {
  const copy: JsonObject = {};
  for (const key of Object.keys(value)) {
    Object.defineProperty(copy, key, {
      value: cloneJsonValue(value[key]),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return copy;
};

const parseSettingsDocument = (text: string): ParseDocumentResult => {
  let cursor = text.charCodeAt(0) === JSON_BOM_CODE ? 1 : 0;
  let parseError: string | undefined;

  const fail = (reason: string): undefined => {
    if (parseError === undefined) {
      parseError = "Invalid settings JSON at character " + cursor + ": " + reason;
    }
    return undefined;
  };

  const skipWhitespace = (): void => {
    while (cursor < text.length) {
      const code = text.charCodeAt(cursor);
      if (code !== JSON_SPACE_CODE && code !== JSON_TAB_CODE && code !== JSON_LINE_FEED_CODE && code !== JSON_CARRIAGE_RETURN_CODE) {
        return;
      }
      cursor += 1;
    }
  };

  const parseStringToken = (): { value: string; start: number; end: number } | undefined => {
    if (text[cursor] !== "\"") {
      return fail("expected a string");
    }

    const start = cursor;
    cursor += 1;
    let value = "";

    while (cursor < text.length) {
      const character = text[cursor];
      const code = text.charCodeAt(cursor);
      if (character === "\"") {
        cursor += 1;
        return { value, start, end: cursor };
      }

      if (character === "\\") {
        cursor += 1;
        if (cursor >= text.length) {
          return fail("unfinished escape");
        }

        const escaped = text[cursor];
        if (escaped === "\"" || escaped === "\\" || escaped === "/") {
          value += escaped;
          cursor += 1;
          continue;
        }
        if (escaped === "b") {
          value += "\b";
          cursor += 1;
          continue;
        }
        if (escaped === "f") {
          value += "\f";
          cursor += 1;
          continue;
        }
        if (escaped === "n") {
          value += "\n";
          cursor += 1;
          continue;
        }
        if (escaped === "r") {
          value += "\r";
          cursor += 1;
          continue;
        }
        if (escaped === "t") {
          value += "\t";
          cursor += 1;
          continue;
        }
        if (escaped === "u") {
          const hexStart = cursor + 1;
          const hexEnd = hexStart + JSON_UNICODE_ESCAPE_LENGTH;
          const hex = text.slice(hexStart, hexEnd);
          if (hex.length !== JSON_UNICODE_ESCAPE_LENGTH || !UNICODE_ESCAPE_PATTERN.test(hex)) {
            return fail("invalid unicode escape");
          }
          value += String.fromCharCode(Number.parseInt(hex, HEX_RADIX));
          cursor = hexEnd;
          continue;
        }
        return fail("invalid escape");
      }

      if (code < JSON_CONTROL_LIMIT) {
        return fail("unescaped control character");
      }

      value += character;
      cursor += 1;
    }

    return fail("unterminated string");
  };

  let parseValue: () => JsonNode | undefined = () => undefined;

  const parseObject = (): JsonObjectNode | undefined => {
    const start = cursor;
    cursor += 1;
    skipWhitespace();
    const properties: JsonProperty[] = [];
    const keys = new Set<string>();

    if (text[cursor] === "}") {
      const closeStart = cursor;
      cursor += 1;
      return { kind: "object", start, end: cursor, closeStart, properties };
    }

    while (cursor < text.length) {
      const keyToken = parseStringToken();
      if (keyToken === undefined) {
        return undefined;
      }
      if (keys.has(keyToken.value)) {
        return fail("duplicate object key " + JSON.stringify(keyToken.value));
      }
      keys.add(keyToken.value);
      skipWhitespace();
      if (text[cursor] !== ":") {
        return fail("expected ':'");
      }
      cursor += 1;
      skipWhitespace();
      const value = parseValue();
      if (value === undefined) {
        return undefined;
      }
      properties.push({
        key: keyToken.value,
        keyStart: keyToken.start,
        keyEnd: keyToken.end,
        value,
      });
      skipWhitespace();

      if (text[cursor] === "}") {
        const closeStart = cursor;
        cursor += 1;
        return { kind: "object", start, end: cursor, closeStart, properties };
      }
      if (text[cursor] !== ",") {
        return fail("expected ',' or '}'");
      }
      cursor += 1;
      skipWhitespace();
      if (text[cursor] === "}") {
        return fail("trailing comma");
      }
    }

    return fail("unterminated object");
  };

  const parseArray = (): JsonArrayNode | undefined => {
    const start = cursor;
    cursor += 1;
    skipWhitespace();
    const items: JsonNode[] = [];

    if (text[cursor] === "]") {
      const closeStart = cursor;
      cursor += 1;
      return { kind: "array", start, end: cursor, closeStart, items };
    }

    while (cursor < text.length) {
      const item = parseValue();
      if (item === undefined) {
        return undefined;
      }
      items.push(item);
      skipWhitespace();

      if (text[cursor] === "]") {
        const closeStart = cursor;
        cursor += 1;
        return { kind: "array", start, end: cursor, closeStart, items };
      }
      if (text[cursor] !== ",") {
        return fail("expected ',' or ']'");
      }
      cursor += 1;
      skipWhitespace();
      if (text[cursor] === "]") {
        return fail("trailing comma");
      }
    }

    return fail("unterminated array");
  };

  parseValue = (): JsonNode | undefined => {
    skipWhitespace();
    const start = cursor;
    const character = text[cursor];

    if (character === "{") {
      return parseObject();
    }
    if (character === "[") {
      return parseArray();
    }
    if (character === "\"") {
      const parsed = parseStringToken();
      return parsed === undefined ? undefined : { kind: "string", start, end: cursor, value: parsed.value };
    }
    if (text.startsWith("true", cursor)) {
      cursor += "true".length;
      return { kind: "boolean", start, end: cursor, value: true };
    }
    if (text.startsWith("false", cursor)) {
      cursor += "false".length;
      return { kind: "boolean", start, end: cursor, value: false };
    }
    if (text.startsWith("null", cursor)) {
      cursor += "null".length;
      return { kind: "null", start, end: cursor };
    }

    const numericText = text.slice(cursor);
    const numberMatch = NUMBER_PATTERN.exec(numericText);
    if (numberMatch !== null) {
      cursor += numberMatch[0].length;
      return { kind: "number", start, end: cursor, value: Number(numberMatch[0]) };
    }

    return fail("expected a JSON value");
  };

  skipWhitespace();
  const root = parseValue();
  if (root === undefined) {
    return { ok: false, error: parseError ?? "Invalid settings JSON" };
  }
  skipWhitespace();
  if (cursor !== text.length) {
    return { ok: false, error: "Invalid settings JSON at character " + cursor + ": unexpected trailing content" };
  }
  if (root.kind !== "object") {
    return { ok: false, error: "Invalid settings JSON: the root value must be an object" };
  }
  return { ok: true, root };
};

const nodeToJsonValue = (node: JsonNode): JsonValue => {
  if (node.kind === "string" || node.kind === "number" || node.kind === "boolean") {
    return node.value;
  }
  if (node.kind === "null") {
    return null;
  }
  if (node.kind === "array") {
    return node.items.map((item) => nodeToJsonValue(item));
  }

  const value: JsonObject = {};
  for (const property of node.properties) {
    Object.defineProperty(value, property.key, {
      value: nodeToJsonValue(property.value),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return value;
};

const serializeJsonValue = (value: JsonValue): string | undefined => {
  try {
    const result = JSON.stringify(value);
    return typeof result === "string" ? result : undefined;
  } catch {
    return undefined;
  }
};

const canonicalJsonValue = (value: JsonValue): string => {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value) ?? "\"\"";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "non-finite:" + String(value);
  }
  if (isUnknownArray(value)) {
    return "[" + value.map((item) => canonicalJsonValue(item)).join(",") + "]";
  }

  const keys = Object.keys(value).sort();
  return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonicalJsonValue(value[key])).join(",") + "}";
};

const hashText = (text: string): string => {
  let hash = HASH_OFFSET_BASIS;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * HASH_PRIME) & HASH_MASK;
  }
  return hash.toString(16).padStart(HASH_HEX_LENGTH, "0");
};

const jsonValuesEqual = (left: JsonValue, right: JsonValue): boolean =>
  canonicalJsonValue(left) === canonicalJsonValue(right);

const objectProperty = (node: JsonObjectNode, key: string): JsonProperty | undefined =>
  node.properties.find((property) => property.key === key);

const lookupPath = (root: JsonObjectNode, path: readonly string[]): PathLookup => {
  let current: JsonNode = root;
  const prefix: string[] = [];

  for (let index = 0; index < path.length; index += 1) {
    if (current.kind !== "object") {
      return { kind: "blocked", node: current, prefix };
    }

    const property = objectProperty(current, path[index]);
    if (property === undefined) {
      return { kind: "missing", parent: current, key: path[index], missingIndex: index };
    }
    if (index === path.length - 1) {
      return { kind: "found", parent: current, property };
    }
    current = property.value;
    prefix.push(path[index]);
  }

  return { kind: "blocked", node: root, prefix: [] };
};

const indentationAt = (text: string, position: number): string => {
  let lineStart = position;
  while (lineStart > 0 && text[lineStart - 1] !== "\n" && text[lineStart - 1] !== "\r") {
    lineStart -= 1;
  }
  const prefix = text.slice(lineStart, position);
  return /^[ \t]*$/.test(prefix) ? prefix : "";
};

const preferredNewline = (text: string): string =>
  text.includes("\r\n") ? "\r\n" : "\n";

const formatAfterComma = (
  text: string,
  openStart: number,
  closeStart: number,
  firstStart: number,
  separatorEnd: number,
  nextStart: number | undefined,
): string => {
  if (nextStart !== undefined) {
    const between = text.slice(separatorEnd, nextStart);
    return between.startsWith(",") ? between.slice(1) : "";
  }

  const tail = text.slice(separatorEnd, closeStart);
  const beforeFirst = text.slice(openStart + 1, firstStart);
  if (tail.includes("\n") || tail.includes("\r") || beforeFirst.includes("\n") || beforeFirst.includes("\r")) {
    return preferredNewline(text) + indentationAt(text, firstStart);
  }
  return JSON_WHITESPACE_PATTERN.test(tail) ? tail : "";
};

const addObjectProperty = (
  text: string,
  object: JsonObjectNode,
  key: string,
  value: JsonValue,
): string | undefined => {
  const serializedKey = JSON.stringify(key);
  const serializedValue = serializeJsonValue(value);
  if (serializedKey === undefined || serializedValue === undefined) {
    return undefined;
  }

  if (object.properties.length === 0) {
    const interior = text.slice(object.start + 1, object.closeStart);
    if (interior.includes("\n") || interior.includes("\r")) {
      const indent = indentationAt(text, object.closeStart) + " ".repeat(JSON_INDENT_STEP);
      const insertion = preferredNewline(text) + indent + serializedKey + ": " + serializedValue;
      return text.slice(0, object.start + 1) + insertion + text.slice(object.start + 1);
    }
    return text.slice(0, object.closeStart) + serializedKey + ": " + serializedValue + text.slice(object.closeStart);
  }

  const first = object.properties[0];
  const last = object.properties[object.properties.length - 1];
  const second = object.properties.length > 1 ? object.properties[1] : undefined;
  const separator = formatAfterComma(text, object.start, object.closeStart, first.keyStart, second === undefined ? last.value.end : first.value.end, second?.keyStart);
  const colonFormatting = text.slice(first.keyEnd, first.value.start);
  const colonSeparator = colonFormatting.startsWith(":") ? colonFormatting : ": ";
  const insertion = "," + separator + serializedKey + colonSeparator + serializedValue;
  return text.slice(0, last.value.end) + insertion + text.slice(last.value.end);
};

const addArrayItem = (text: string, array: JsonArrayNode, value: JsonValue): string | undefined => {
  const serializedValue = serializeJsonValue(value);
  if (serializedValue === undefined) {
    return undefined;
  }

  if (array.items.length === 0) {
    const interior = text.slice(array.start + 1, array.closeStart);
    if (interior.includes("\n") || interior.includes("\r")) {
      const indent = indentationAt(text, array.closeStart) + " ".repeat(JSON_INDENT_STEP);
      const insertion = preferredNewline(text) + indent + serializedValue;
      return text.slice(0, array.start + 1) + insertion + text.slice(array.start + 1);
    }
    return text.slice(0, array.closeStart) + serializedValue + text.slice(array.closeStart);
  }

  const first = array.items[0];
  const last = array.items[array.items.length - 1];
  const second = array.items.length > 1 ? array.items[1] : undefined;
  const separator = formatAfterComma(text, array.start, array.closeStart, first.start, second === undefined ? last.end : first.end, second?.start);
  return text.slice(0, last.end) + "," + separator + serializedValue + text.slice(last.end);
};

const removeObjectProperty = (text: string, object: JsonObjectNode, index: number): string => {
  const property = object.properties[index];
  const next = object.properties[index + 1];
  const previous = object.properties[index - 1];

  if (next !== undefined) {
    return text.slice(0, property.keyStart) + text.slice(next.keyStart);
  }
  if (previous !== undefined) {
    return text.slice(0, previous.value.end) + text.slice(property.value.end);
  }
  return text.slice(0, property.keyStart) + text.slice(property.value.end);
};

const removeArrayItem = (text: string, array: JsonArrayNode, index: number): string => {
  const item = array.items[index];
  const next = array.items[index + 1];
  const previous = array.items[index - 1];

  if (next !== undefined) {
    return text.slice(0, item.start) + text.slice(next.start);
  }
  if (previous !== undefined) {
    return text.slice(0, previous.end) + text.slice(item.end);
  }
  return text.slice(0, item.start) + text.slice(item.end);
};

const replaceNodeValue = (text: string, node: JsonNode, value: JsonValue): string | undefined => {
  const serialized = serializeJsonValue(value);
  return serialized === undefined
    ? undefined
    : text.slice(0, node.start) + serialized + text.slice(node.end);
};

const nestedValueAtPath = (path: readonly string[], startIndex: number, value: JsonValue): JsonValue => {
  let nested = value;
  for (let index = path.length - 1; index > startIndex; index -= 1) {
    const object: JsonObject = {};
    Object.defineProperty(object, path[index], {
      value: nested,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    nested = object;
  }
  return nested;
};

const setPathValue = (text: string, path: readonly string[], value: JsonValue): string | undefined => {
  const document = parseSettingsDocument(text);
  if (!document.ok) {
    return undefined;
  }

  const lookup = lookupPath(document.root, path);
  if (lookup.kind === "found") {
    return replaceNodeValue(text, lookup.property.value, value);
  }
  if (lookup.kind === "blocked") {
    return undefined;
  }

  const nested = nestedValueAtPath(path, lookup.missingIndex, value);
  return addObjectProperty(text, lookup.parent, lookup.key, nested);
};

const removePathProperty = (text: string, path: readonly string[]): string | undefined => {
  const document = parseSettingsDocument(text);
  if (!document.ok) {
    return undefined;
  }
  const lookup = lookupPath(document.root, path);
  if (lookup.kind !== "found") {
    return undefined;
  }
  const index = lookup.parent.properties.indexOf(lookup.property);
  return removeObjectProperty(text, lookup.parent, index);
};

const arrayAtPath = (text: string, path: readonly string[]): JsonArrayNode | undefined => {
  const document = parseSettingsDocument(text);
  if (!document.ok) {
    return undefined;
  }
  const lookup = lookupPath(document.root, path);
  return lookup.kind === "found" && lookup.property.value.kind === "array"
    ? lookup.property.value
    : undefined;
};

const objectEntry = (entries: readonly (readonly [string, JsonValue])[]): JsonObject => {
  const object: JsonObject = {};
  for (const [key, value] of entries) {
    Object.defineProperty(object, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return object;
};

const makeValueRecord = (desired: DesiredValueSetting, value: JsonValue, owned = true): ValueOwnershipRecord => ({
  id: desired.id,
  feature: desired.feature,
  kind: "value",
  path: [...desired.path],
  value: cloneJsonValue(value),
  owned,
});

const makeListRecord = (
  desired: DesiredListEntrySetting,
  array: JsonArrayNode,
  index: number,
  containerCreated: boolean,
): ListEntryOwnershipRecord => {
  const before = index > 0 ? nodeToJsonValue(array.items[index - 1]) : undefined;
  const after = index + 1 < array.items.length ? nodeToJsonValue(array.items[index + 1]) : undefined;
  return {
    id: desired.id,
    feature: desired.feature,
    kind: "list-entry",
    path: [...desired.path],
    value: desired.value,
    owned: true,
    index,
    arrayLength: array.items.length,
    ...(before === undefined ? {} : { beforeValue: before }),
    ...(after === undefined ? {} : { afterValue: after }),
    containerCreated,
  };
};

const makeHookRecord = (desired: DesiredHookSetting, match: HookMatch): HookOwnershipRecord => {
  const before = match.entryIndex > 0
    ? nodeToJsonValue(match.hooksNode.items[match.entryIndex - 1])
    : undefined;
  const after = match.entryIndex + 1 < match.hooksNode.items.length
    ? nodeToJsonValue(match.hooksNode.items[match.entryIndex + 1])
    : undefined;
  return {
    id: desired.id,
    feature: desired.feature,
    kind: "hook",
    event: match.event,
    matcher: match.matcher,
    scriptName: desired.scriptName,
    value: cloneJsonObject(match.value),
    owned: true,
    index: match.entryIndex,
    groupIndex: match.groupIndex,
    arrayLength: match.hooksNode.items.length,
    ...(before === undefined ? {} : { beforeValue: before }),
    ...(after === undefined ? {} : { afterValue: after }),
  };
};

const recordIsOwned = (record: SettingsOwnershipRecord): boolean => record.owned !== false;

const recordChangeHash = (record: SettingsOwnershipRecord, value: JsonValue): string =>
  hashText(record.kind + "\u0000" + record.id + "\u0000" + canonicalJsonValue(value));

function appendKeptEvent(
  events: SettingKeptEvent[],
  record: ValueOwnershipRecord,
  hash: string,
  backupPath: string,
): ValueOwnershipRecord;
function appendKeptEvent(
  events: SettingKeptEvent[],
  record: ListEntryOwnershipRecord,
  hash: string,
  backupPath: string,
): ListEntryOwnershipRecord;
function appendKeptEvent(
  events: SettingKeptEvent[],
  record: HookOwnershipRecord,
  hash: string,
  backupPath: string,
): HookOwnershipRecord;
function appendKeptEvent(
  events: SettingKeptEvent[],
  record: SettingsOwnershipRecord,
  hash: string,
  backupPath: string,
): SettingsOwnershipRecord {
  if (record.seenHash !== hash) {
    events.push({
      type: "setting-kept",
      level: "warn",
      text: "Rig сохранил изменённую настройку \"" + record.id + "\". Копия: " + backupPath,
    });
  }
  if (record.kind === "value") {
    return { ...record, seenHash: hash };
  }
  if (record.kind === "list-entry") {
    return { ...record, seenHash: hash };
  }
  return { ...record, seenHash: hash };
}

const addBackupValue = (
  backupValues: SettingsBackupValue[],
  id: string,
  location: readonly string[],
  value: JsonValue,
): void => {
  backupValues.push({
    id,
    location: [...location],
    value: cloneJsonValue(value),
  });
};

const valuesInArray = (array: JsonArrayNode, value: JsonValue): number[] => {
  const indexes: number[] = [];
  array.items.forEach((item, index) => {
    if (jsonValuesEqual(nodeToJsonValue(item), value)) {
      indexes.push(index);
    }
  });
  return indexes;
};

const observeListRecord = (record: ListEntryOwnershipRecord, array: JsonArrayNode): ListObservation => {
  const exactIndexes = valuesInArray(array, record.value);
  if (exactIndexes.length === 1) {
    return { kind: "unchanged", index: exactIndexes[0] };
  }
  if (exactIndexes.length > 1) {
    if (record.index !== undefined && exactIndexes.includes(record.index)) {
      return { kind: "unchanged", index: record.index };
    }
    return { kind: "ambiguous", value: nodeToJsonValue(array) };
  }

  if (record.index === undefined || record.index >= array.items.length) {
    return { kind: "missing" };
  }

  const beforeMatches = record.beforeValue === undefined
    ? record.index === 0
    : record.index > 0 && jsonValuesEqual(nodeToJsonValue(array.items[record.index - 1]), record.beforeValue);
  const afterMatches = record.afterValue === undefined
    ? record.index === array.items.length - 1
    : record.index + 1 < array.items.length && jsonValuesEqual(nodeToJsonValue(array.items[record.index + 1]), record.afterValue);

  if (beforeMatches && afterMatches) {
    return {
      kind: "changed",
      index: record.index,
      value: nodeToJsonValue(array.items[record.index]),
    };
  }
  return { kind: "missing" };
};

const propertyIndex = (object: JsonObjectNode, key: string): number =>
  object.properties.findIndex((property) => property.key === key);

const processValueSetting = (
  work: MergeWork,
  desired: DesiredValueSetting,
  previous: ValueOwnershipRecord | undefined,
  backupPath: string,
): ValueOwnershipRecord => {
  const document = parseSettingsDocument(work.text);
  if (!document.ok) {
    return makeValueRecord(desired, desired.value, false);
  }
  const lookup = lookupPath(document.root, desired.path);

  if (lookup.kind === "missing") {
    const inserted = setPathValue(work.text, desired.path, desired.value);
    if (inserted !== undefined) {
      work.text = inserted;
      return makeValueRecord(desired, desired.value);
    }
    const blockedHash = hashText("missing:" + desired.path.join("\u0000"));
    const base = previous ?? makeValueRecord(desired, desired.value, false);
    return appendKeptEvent(work.events, base, blockedHash, backupPath);
  }

  if (lookup.kind === "blocked") {
    const blockedValue = nodeToJsonValue(lookup.node);
    const conflictHash = hashText(lookup.prefix.join("\u0000") + "\u0000" + canonicalJsonValue(blockedValue));
    const base = previous ?? makeValueRecord(desired, desired.value, false);
    const tracked = appendKeptEvent(work.events, base, conflictHash, backupPath);
    return {
      id: desired.id,
      feature: desired.feature,
      kind: "value",
      path: [...desired.path],
      value: previous?.value ?? cloneJsonValue(desired.value),
      owned: previous === undefined ? false : recordIsOwned(previous),
      seenHash: tracked.seenHash,
    };
  }

  const currentValue = nodeToJsonValue(lookup.property.value);
  if (previous === undefined) {
    if (jsonValuesEqual(currentValue, desired.value)) {
      return makeValueRecord(desired, currentValue);
    }
    const record = makeValueRecord(desired, desired.value, false);
    return appendKeptEvent(work.events, record, recordChangeHash(record, currentValue), backupPath);
  }

  if (!recordIsOwned(previous)) {
    if (jsonValuesEqual(currentValue, desired.value)) {
      return makeValueRecord(desired, currentValue);
    }
    const conflict = appendKeptEvent(work.events, previous, recordChangeHash(previous, currentValue), backupPath);
    return { ...conflict, value: cloneJsonValue(desired.value), owned: false };
  }

  if (jsonValuesEqual(currentValue, previous.value)) {
    if (!jsonValuesEqual(currentValue, desired.value)) {
      const replaced = replaceNodeValue(work.text, lookup.property.value, desired.value);
      if (replaced !== undefined) {
        work.text = replaced;
      }
    }
    return makeValueRecord(desired, desired.value);
  }

  const changed = appendKeptEvent(work.events, previous, recordChangeHash(previous, currentValue), backupPath);
  return { ...changed, path: [...desired.path], feature: desired.feature };
};

const processListEntry = (
  work: MergeWork,
  desired: DesiredListEntrySetting,
  previousRecord: ListEntryOwnershipRecord | undefined,
  backupPath: string,
): ListEntryOwnershipRecord | undefined => {
  if (isAutoModeDefaultsEntry(desired.path, desired.value)) {
    return undefined;
  }
  const previous = previousRecord !== undefined && isAutoModeDefaultsEntry(previousRecord.path, previousRecord.value)
    ? undefined
    : previousRecord;

  const document = parseSettingsDocument(work.text);
  if (!document.ok) {
    return undefined;
  }
  const lookup = lookupPath(document.root, desired.path);

  if (lookup.kind === "blocked") {
    const blockedValue = nodeToJsonValue(lookup.node);
    const conflictHash = hashText(lookup.prefix.join("\u0000") + "\u0000" + canonicalJsonValue(blockedValue));
    const base: ListEntryOwnershipRecord = previous ?? {
      id: desired.id,
      feature: desired.feature,
      kind: "list-entry",
      path: [...desired.path],
      value: desired.value,
      owned: false,
    };
    const tracked = appendKeptEvent(work.events, base, conflictHash, backupPath);
    return { ...tracked, feature: desired.feature, owned: previous === undefined ? false : recordIsOwned(previous) };
  }

  if (lookup.kind === "found" && lookup.property.value.kind !== "array") {
    const currentValue = nodeToJsonValue(lookup.property.value);
    const base: ListEntryOwnershipRecord = previous ?? {
      id: desired.id,
      feature: desired.feature,
      kind: "list-entry",
      path: [...desired.path],
      value: desired.value,
      owned: false,
    };
    const currentHash = recordChangeHash(base, currentValue);
    const tracked = appendKeptEvent(work.events, base, currentHash, backupPath);
    return { ...tracked, feature: desired.feature, owned: previous === undefined ? false : recordIsOwned(previous) };
  }

  if (lookup.kind === "missing") {
    const autoModeList = desired.path.length === AUTO_MODE_PATH_DEPTH && desired.path[0] === "autoMode";
    const initialValues = autoModeList
      ? [AUTO_MODE_DEFAULTS_ENTRY, desired.value]
      : [desired.value];
    const inserted = setPathValue(work.text, desired.path, initialValues);
    if (inserted === undefined) {
      return undefined;
    }
    work.text = inserted;
    const array = arrayAtPath(work.text, desired.path);
    return array === undefined
      ? undefined
      : makeListRecord(desired, array, autoModeList ? AUTO_MODE_ENTRY_INDEX : FIRST_LIST_ENTRY_INDEX, true);
  }

  const array = lookup.property.value;
  if (array.kind !== "array") {
    return undefined;
  }

  const desiredIndexes = valuesInArray(array, desired.value);
  if (previous === undefined || !recordIsOwned(previous)) {
    if (desiredIndexes.length === 1) {
      return makeListRecord(desired, array, desiredIndexes[0], false);
    }
    if (desiredIndexes.length > 1) {
      return undefined;
    }

    const appended = addArrayItem(work.text, array, desired.value);
    if (appended === undefined) {
      return undefined;
    }
    work.text = appended;
    const updatedArray = arrayAtPath(work.text, desired.path);
    return updatedArray === undefined
      ? undefined
      : makeListRecord(desired, updatedArray, updatedArray.items.length - 1, false);
  }

  const observation = observeListRecord(previous, array);
  if (observation.kind === "unchanged") {
    if (previous.value !== desired.value) {
      if (desiredIndexes.length === 0) {
        const updated = replaceNodeValue(work.text, array.items[observation.index], desired.value);
        if (updated !== undefined) {
          work.text = updated;
        }
        const updatedArray = arrayAtPath(work.text, desired.path);
        return updatedArray === undefined
          ? undefined
          : makeListRecord(desired, updatedArray, observation.index, previous.containerCreated === true);
      }

      const removed = removeArrayItem(work.text, array, observation.index);
      work.text = removed;
      const updatedArray = arrayAtPath(work.text, desired.path);
      if (updatedArray !== undefined) {
        const matches = valuesInArray(updatedArray, desired.value);
        if (matches.length === 1) {
          return makeListRecord(desired, updatedArray, matches[0], previous.containerCreated === true);
        }
      }
      return undefined;
    }

    return makeListRecord(desired, array, observation.index, previous.containerCreated === true);
  }

  if (observation.kind === "changed") {
    const changedHash = recordChangeHash(previous, observation.value);
    const tracked = appendKeptEvent(work.events, previous, changedHash, backupPath);
    return { ...tracked, feature: desired.feature, path: [...desired.path] };
  }

  if (observation.kind === "ambiguous") {
    const changedHash = recordChangeHash(previous, observation.value);
    const tracked = appendKeptEvent(work.events, previous, changedHash, backupPath);
    return { ...tracked, feature: desired.feature, path: [...desired.path] };
  }

  if (desiredIndexes.length === 1) {
    return makeListRecord(desired, array, desiredIndexes[0], previous.containerCreated === true);
  }
  if (desiredIndexes.length > 1) {
    return undefined;
  }

  const appended = addArrayItem(work.text, array, desired.value);
  if (appended === undefined) {
    return undefined;
  }
  work.text = appended;
  const updatedArray = arrayAtPath(work.text, desired.path);
  return updatedArray === undefined
    ? undefined
    : makeListRecord(desired, updatedArray, updatedArray.items.length - 1, previous.containerCreated === true);
};

const normalizeCommand = (command: string): string =>
  command.trim().split(/\s+/).filter((part) => part.length > 0).join(" ");

const hasScriptName = (value: string, scriptName: string): boolean => {
  const normalizedValue = value.replace(/\\/g, "/");
  const normalizedName = scriptName.replace(/\\/g, "/");
  let index = normalizedValue.indexOf(normalizedName);

  while (index >= 0) {
    const before = index > 0 ? normalizedValue[index - 1] : undefined;
    const afterIndex = index + normalizedName.length;
    const after = afterIndex < normalizedValue.length ? normalizedValue[afterIndex] : undefined;
    const beforeMatches = before === undefined || !IDENTIFIER_BOUNDARY_PATTERN.test(before);
    const afterMatches = after === undefined || !IDENTIFIER_BOUNDARY_PATTERN.test(after);
    if (beforeMatches && afterMatches) {
      return true;
    }
    index = normalizedValue.indexOf(normalizedName, index + 1);
  }

  return false;
};

const scanStringNodes = (node: JsonNode, predicate: (value: string) => boolean): boolean => {
  if (node.kind === "string") {
    return predicate(node.value);
  }
  if (node.kind === "array") {
    return node.items.some((item) => scanStringNodes(item, predicate));
  }
  if (node.kind === "object") {
    return node.properties.some((property) => scanStringNodes(property.value, predicate));
  }
  return false;
};

const hookMatchesIdentity = (entry: JsonObjectNode, scriptName: string): boolean => {
  const commandProperty = objectProperty(entry, "command");
  if (scriptName === "rtk hook claude") {
    if (commandProperty === undefined || commandProperty.value.kind !== "string") return false;
    const argsProperty = objectProperty(entry, "args");
    const argumentValues: string[] = [];
    if (argsProperty !== undefined && argsProperty.value.kind === "array") {
      for (const item of argsProperty.value.items) {
        if (item.kind === "string") argumentValues.push(item.value);
      }
    }
    return normalizeCommand([commandProperty.value.value, ...argumentValues].join(" ")) === scriptName;
  }

  if (commandProperty !== undefined
    && commandProperty.value.kind === "string"
    && hasScriptName(commandProperty.value.value, scriptName)) {
    return true;
  }

  const argsProperty = objectProperty(entry, "args");
  return argsProperty !== undefined
    && scanStringNodes(argsProperty.value, (value) => hasScriptName(value, scriptName));
};

const hookGroupMatcher = (group: JsonNode): string | undefined => {
  if (group.kind !== "object") {
    return undefined;
  }
  const matcher = objectProperty(group, "matcher");
  if (matcher === undefined) {
    return "";
  }
  return matcher.value.kind === "string" ? matcher.value.value : undefined;
};

// The arguments that follow the script path say what a hook runs: the same script with other
// arguments is another hook. The interpreter and the path before the script are not compared.
const hookTrailingArguments = (value: JsonObject, scriptName: string): string[] | undefined => {
  const command = value.command;
  const args = value.args;
  const tokens: string[] = [];
  if (typeof command === "string") {
    tokens.push(...command.split(/\s+/));
  }
  if (Array.isArray(args)) {
    for (const item of args) {
      if (typeof item === "string") tokens.push(item);
    }
  }
  const words = tokens.map((token) => token.replace(/^["']|["']$/g, "")).filter((token) => token.length > 0);
  const scriptIndex = words.findIndex((word) => hasScriptName(word, scriptName));
  return scriptIndex < 0 ? undefined : words.slice(scriptIndex + 1);
};

const sameHookArguments = (match: HookMatch, scriptName: string, reference: JsonObject): boolean => {
  const expected = hookTrailingArguments(reference, scriptName);
  const actual = hookTrailingArguments(match.value, scriptName);
  return expected === undefined || actual === undefined
    || (expected.length === actual.length && expected.every((word, index) => word === actual[index]));
};

const findHookMatches = (
  text: string,
  scriptName: string,
  accept: (match: HookMatch) => boolean = () => true,
): HookMatch[] => {
  const document = parseSettingsDocument(text);
  if (!document.ok) {
    return [];
  }
  const hooksProperty = objectProperty(document.root, "hooks");
  if (hooksProperty === undefined || hooksProperty.value.kind !== "object") {
    return [];
  }

  const matches: HookMatch[] = [];
  for (const eventProperty of hooksProperty.value.properties) {
    if (eventProperty.value.kind !== "array") {
      continue;
    }
    const eventArray = eventProperty.value;
    eventArray.items.forEach((group, groupIndex) => {
      const matcher = hookGroupMatcher(group);
      if (matcher === undefined || group.kind !== "object") {
        return;
      }
      const hooksProperty = objectProperty(group, "hooks");
      if (hooksProperty === undefined || hooksProperty.value.kind !== "array") {
        return;
      }
      const hooksArray = hooksProperty.value;
      hooksArray.items.forEach((entryNode, entryIndex) => {
        if (entryNode.kind !== "object" || !hookMatchesIdentity(entryNode, scriptName)) {
          return;
        }
        const entryValue = nodeToJsonValue(entryNode);
        if (!isJsonObject(entryValue)) {
          return;
        }
        const match: HookMatch = {
          event: eventProperty.key,
          matcher,
          groupIndex,
          entryIndex,
          hooksNode: hooksArray,
          entryNode,
          value: entryValue,
        };
        if (accept(match)) {
          matches.push(match);
        }
      });
    });
  }
  return matches;
};

const makeDesiredHookGroup = (desired: DesiredHookSetting): JsonObject =>
  objectEntry([
    ["matcher", desired.matcher],
    ["hooks", [cloneJsonValue(desired.value)]],
  ]);

const appendHook = (text: string, desired: DesiredHookSetting): string | undefined => {
  const document = parseSettingsDocument(text);
  if (!document.ok) {
    return undefined;
  }
  const hooksProperty = objectProperty(document.root, "hooks");
  const newGroup = makeDesiredHookGroup(desired);

  if (hooksProperty === undefined) {
    const hooksValue = objectEntry([[desired.event, [newGroup]]]);
    return addObjectProperty(text, document.root, "hooks", hooksValue);
  }
  if (hooksProperty.value.kind !== "object") {
    return undefined;
  }

  const eventProperty = objectProperty(hooksProperty.value, desired.event);
  if (eventProperty === undefined) {
    return addObjectProperty(text, hooksProperty.value, desired.event, [newGroup]);
  }
  if (eventProperty.value.kind !== "array") {
    return undefined;
  }
  const eventArray = eventProperty.value;

  let groupNode: JsonObjectNode | undefined;
  for (let index = 0; index < eventArray.items.length; index += 1) {
    const group = eventArray.items[index];
    if (group.kind === "object" && hookGroupMatcher(group) === desired.matcher) {
      groupNode = group;
      break;
    }
  }

  if (groupNode === undefined) {
    return addArrayItem(text, eventArray, newGroup);
  }

  const groupHooks = objectProperty(groupNode, "hooks");
  if (groupHooks === undefined) {
    return addObjectProperty(text, groupNode, "hooks", [cloneJsonValue(desired.value)]);
  }
  if (groupHooks.value.kind !== "array") {
    return undefined;
  }
  return addArrayItem(text, groupHooks.value, desired.value);
};

const makeHookChangeValue = (match: HookMatch): JsonValue =>
  objectEntry([
    ["event", match.event],
    ["matcher", match.matcher],
    ["value", match.value],
  ]);

const hookMatchLocation = (match: HookMatch): string[] =>
  ["hooks", match.event, match.matcher];

const createHookRecordFromMatch = (
  desired: DesiredHookSetting,
  match: HookMatch,
): HookOwnershipRecord => makeHookRecord(desired, match);

const findRecordedHook = (text: string, record: HookOwnershipRecord): HookMatch | undefined => {
  const document = parseSettingsDocument(text);
  if (!document.ok) {
    return undefined;
  }
  const hooksProperty = objectProperty(document.root, "hooks");
  if (hooksProperty === undefined || hooksProperty.value.kind !== "object") {
    return undefined;
  }
  const eventProperty = objectProperty(hooksProperty.value, record.event);
  if (eventProperty === undefined || eventProperty.value.kind !== "array") {
    return undefined;
  }
  const eventArray = eventProperty.value;

  const matchingGroupIndexes: number[] = [];
  eventArray.items.forEach((group, index) => {
    if (hookGroupMatcher(group) === record.matcher) {
      matchingGroupIndexes.push(index);
    }
  });
  const groupIndex = record.groupIndex !== undefined
    && matchingGroupIndexes.includes(record.groupIndex)
    ? record.groupIndex
    : matchingGroupIndexes.length === 1
      ? matchingGroupIndexes[0]
      : undefined;
  if (groupIndex === undefined) {
    return undefined;
  }

  const group = eventArray.items[groupIndex];
  if (group.kind !== "object") {
    return undefined;
  }
  const groupHooksProperty = objectProperty(group, "hooks");
  if (groupHooksProperty === undefined || groupHooksProperty.value.kind !== "array") {
    return undefined;
  }
  const hooksArray = groupHooksProperty.value;
  const entryIndex = record.index;
  if (entryIndex === undefined || entryIndex >= hooksArray.items.length) {
    return undefined;
  }

  const beforeMatches = record.beforeValue === undefined
    ? entryIndex === 0
    : entryIndex > 0 && jsonValuesEqual(nodeToJsonValue(hooksArray.items[entryIndex - 1]), record.beforeValue);
  const afterMatches = record.afterValue === undefined
    ? entryIndex === hooksArray.items.length - 1
    : entryIndex + 1 < hooksArray.items.length
      && jsonValuesEqual(nodeToJsonValue(hooksArray.items[entryIndex + 1]), record.afterValue);
  if (!beforeMatches || !afterMatches) {
    return undefined;
  }
  if (record.arrayLength !== undefined
    && record.beforeValue === undefined
    && record.afterValue === undefined
    && record.arrayLength !== hooksArray.items.length) {
    return undefined;
  }

  const entryNode = hooksArray.items[entryIndex];
  if (entryNode.kind !== "object") {
    return undefined;
  }
  const value = nodeToJsonValue(entryNode);
  if (!isJsonObject(value)) {
    return undefined;
  }
  return {
    event: record.event,
    matcher: record.matcher,
    groupIndex,
    entryIndex,
    hooksNode: hooksArray,
    entryNode,
    value,
  };
};

const groupHasOnlyHookFields = (group: JsonObjectNode): boolean =>
  group.properties.every((property) => property.key === "matcher" || property.key === "hooks");

const removeHookMatch = (text: string, match: HookMatch): string | undefined => {
  let updated = removeArrayItem(text, match.hooksNode, match.entryIndex);
  let document = parseSettingsDocument(updated);
  if (!document.ok) {
    return undefined;
  }

  const hooksProperty = objectProperty(document.root, "hooks");
  if (hooksProperty === undefined || hooksProperty.value.kind !== "object") {
    return updated;
  }
  const eventProperty = objectProperty(hooksProperty.value, match.event);
  if (eventProperty === undefined || eventProperty.value.kind !== "array") {
    return updated;
  }

  const group = eventProperty.value.items[match.groupIndex];
  if (group !== undefined && group.kind === "object") {
    const groupHooks = objectProperty(group, "hooks");
    if (groupHooks !== undefined && groupHooks.value.kind === "array" && groupHooks.value.items.length === 0 && groupHasOnlyHookFields(group)) {
      updated = removeArrayItem(updated, eventProperty.value, match.groupIndex);
      document = parseSettingsDocument(updated);
      if (!document.ok) {
        return undefined;
      }
    }
  }

  const currentHooksProperty = objectProperty(document.root, "hooks");
  if (currentHooksProperty === undefined || currentHooksProperty.value.kind !== "object") {
    return updated;
  }
  const currentEventProperty = objectProperty(currentHooksProperty.value, match.event);
  if (currentEventProperty !== undefined && currentEventProperty.value.kind === "array" && currentEventProperty.value.items.length === 0) {
    const eventIndex = propertyIndex(currentHooksProperty.value, match.event);
    updated = removeObjectProperty(updated, currentHooksProperty.value, eventIndex);
    document = parseSettingsDocument(updated);
    if (!document.ok) {
      return undefined;
    }
  }

  const finalHooksProperty = objectProperty(document.root, "hooks");
  if (finalHooksProperty !== undefined && finalHooksProperty.value.kind === "object" && finalHooksProperty.value.properties.length === 0) {
    const hooksIndex = propertyIndex(document.root, "hooks");
    updated = removeObjectProperty(updated, document.root, hooksIndex);
  }
  return updated;
};

const desiredHookRecordAfterInsert = (
  text: string,
  desired: DesiredHookSetting,
  accept: (match: HookMatch) => boolean,
): HookOwnershipRecord | undefined => {
  const matches = findHookMatches(text, desired.scriptName, accept);
  return matches.length === 1 ? createHookRecordFromMatch(desired, matches[0]) : undefined;
};

// A hook is told apart by its script, its trailing arguments and its own event and matcher: a place
// where a sibling hook of the same feature (same script, other event or matcher) lives is not ours.
const hookAcceptor = (
  desired: DesiredHookSetting,
  reference: JsonObject,
  siblings: readonly DesiredHookSetting[],
): ((match: HookMatch) => boolean) => (match) =>
  sameHookArguments(match, desired.scriptName, reference)
  && !siblings.some((sibling) =>
    sibling.id !== desired.id
    && sibling.scriptName === desired.scriptName
    && sibling.event === match.event
    && sibling.matcher === match.matcher
    && (sibling.event !== desired.event || sibling.matcher !== desired.matcher));

const processHookSetting = (
  work: MergeWork,
  desired: DesiredHookSetting,
  previous: HookOwnershipRecord | undefined,
  backupPath: string,
  siblings: readonly DesiredHookSetting[],
): HookOwnershipRecord | undefined => {
  const identity = previous?.scriptName ?? desired.scriptName;
  const accept = hookAcceptor(desired, previous?.value ?? desired.value, siblings);
  const matches = findHookMatches(work.text, identity, accept);
  const acceptDesired = hookAcceptor(desired, desired.value, siblings);

  if (matches.length === 0 && previous !== undefined && recordIsOwned(previous)) {
    const recorded = findRecordedHook(work.text, previous);
    if (recorded !== undefined) {
      const locationMatches = recorded.event === previous.event
        && recorded.matcher === previous.matcher
        && (previous.groupIndex === undefined || recorded.groupIndex === previous.groupIndex);
      const valueMatches = jsonValuesEqual(recorded.value, previous.value);
      if (!locationMatches || !valueMatches) {
        const changedHash = recordChangeHash(previous, makeHookChangeValue(recorded));
        return appendKeptEvent(work.events, previous, changedHash, backupPath);
      }
      const removed = removeHookMatch(work.text, recorded);
      if (removed !== undefined) {
        const inserted = appendHook(removed, desired);
        if (inserted !== undefined) {
          work.text = inserted;
          return desiredHookRecordAfterInsert(work.text, desired, acceptDesired);
        }
      }
    }
  }

  if (matches.length === 0) {
    const inserted = appendHook(work.text, desired);
    if (inserted === undefined) {
      if (previous === undefined) {
        return {
          id: desired.id,
          feature: desired.feature,
          kind: "hook",
          event: desired.event,
          matcher: desired.matcher,
          scriptName: desired.scriptName,
          value: cloneJsonObject(desired.value),
          owned: false,
          seenHash: hashText("blocked-hook:" + desired.event + "\u0000" + desired.matcher),
        };
      }
      const blockedHash = hashText("blocked-hook:" + desired.event + "\u0000" + desired.matcher);
      return appendKeptEvent(work.events, previous, blockedHash, backupPath);
    }
    work.text = inserted;
    return desiredHookRecordAfterInsert(work.text, desired, acceptDesired);
  }

  if (previous === undefined) {
    if (matches.length !== 1) {
      return undefined;
    }
    return createHookRecordFromMatch(desired, matches[0]);
  }

  if (!recordIsOwned(previous)) {
    if (matches.length !== 1) {
      return undefined;
    }
    return createHookRecordFromMatch(desired, matches[0]);
  }

  if (matches.length !== 1) {
    const allMatches = matches.map((match) => makeHookChangeValue(match));
    const observed: JsonValue = allMatches;
    const changedHash = recordChangeHash(previous, observed);
    return appendKeptEvent(work.events, previous, changedHash, backupPath);
  }

  const match = matches[0];
  const locationMatches = match.event === previous.event
    && match.matcher === previous.matcher
    && (previous.groupIndex === undefined || match.groupIndex === previous.groupIndex);
  const valueMatches = jsonValuesEqual(match.value, previous.value);

  if (!locationMatches || !valueMatches) {
    const changedHash = recordChangeHash(previous, makeHookChangeValue(match));
    return appendKeptEvent(work.events, previous, changedHash, backupPath);
  }

  const desiredLocationMatches = match.event === desired.event && match.matcher === desired.matcher;
  if (desiredLocationMatches && jsonValuesEqual(match.value, desired.value)) {
    return makeHookRecord(desired, match);
  }

  if (desiredLocationMatches) {
    const updated = replaceNodeValue(work.text, match.entryNode, desired.value);
    if (updated !== undefined) {
      work.text = updated;
      const after = findHookMatches(work.text, desired.scriptName, acceptDesired);
      return after.length === 1 ? createHookRecordFromMatch(desired, after[0]) : undefined;
    }
  } else {
    const removed = removeHookMatch(work.text, match);
    if (removed !== undefined) {
      const inserted = appendHook(removed, desired);
      if (inserted !== undefined) {
        work.text = inserted;
        return desiredHookRecordAfterInsert(work.text, desired, acceptDesired);
      }
    }
  }

  const unchangedHash = recordChangeHash(previous, makeHookChangeValue(match));
  return appendKeptEvent(work.events, previous, unchangedHash, backupPath);
};

const recordKindMatchesDesired = (
  record: SettingsOwnershipRecord,
  desired: DesiredSettingEntry,
): boolean =>
  desired.kind !== "install-default"
  && record.kind === desired.kind
  && record.feature === desired.feature;

const removeStaleValueRecord = (
  work: MergeWork,
  record: ValueOwnershipRecord,
  backupPath: string,
): void => {
  if (!recordIsOwned(record)) {
    return;
  }

  const document = parseSettingsDocument(work.text);
  if (!document.ok) {
    return;
  }
  const lookup = lookupPath(document.root, record.path);
  if (lookup.kind !== "found") {
    return;
  }

  const currentValue = nodeToJsonValue(lookup.property.value);
  if (!jsonValuesEqual(currentValue, record.value)) {
    addBackupValue(work.backupValues, record.id, record.path, currentValue);
    work.events.push({
      type: "setting-kept",
      level: "warn",
      text: "Rig удалил изменённую настройку \"" + record.id + "\"; значение сохранено в копии: " + backupPath,
    });
  }
  const index = lookup.parent.properties.indexOf(lookup.property);
  work.text = removeObjectProperty(work.text, lookup.parent, index);
};

const removeStaleListRecord = (
  work: MergeWork,
  record: ListEntryOwnershipRecord,
  backupPath: string,
): void => {
  if (!recordIsOwned(record) || isAutoModeDefaultsEntry(record.path, record.value)) {
    return;
  }

  const document = parseSettingsDocument(work.text);
  if (!document.ok) {
    return;
  }
  const lookup = lookupPath(document.root, record.path);
  if (lookup.kind === "blocked" || lookup.kind === "missing") {
    return;
  }

  if (lookup.property.value.kind !== "array") {
    const currentValue = nodeToJsonValue(lookup.property.value);
    addBackupValue(work.backupValues, record.id, record.path, currentValue);
    work.events.push({
      type: "setting-kept",
      level: "warn",
      text: "Rig удалил изменённую настройку \"" + record.id + "\"; значение сохранено в копии: " + backupPath,
    });
    const property = lookup.property;
    const index = lookup.parent.properties.indexOf(property);
    work.text = removeObjectProperty(work.text, lookup.parent, index);
    return;
  }

  const observation = observeListRecord(record, lookup.property.value);
  if (observation.kind === "unchanged") {
    work.text = removeArrayItem(work.text, lookup.property.value, observation.index);
  } else if (observation.kind === "changed") {
    addBackupValue(work.backupValues, record.id, record.path, observation.value);
    work.events.push({
      type: "setting-kept",
      level: "warn",
      text: "Rig удалил изменённую настройку \"" + record.id + "\"; значение сохранено в копии: " + backupPath,
    });
    work.text = removeArrayItem(work.text, lookup.property.value, observation.index);
  } else if (observation.kind === "ambiguous") {
    const hash = recordChangeHash(record, observation.value);
    appendKeptEvent(work.events, record, hash, backupPath);
    return;
  } else {
    return;
  }

  if (record.containerCreated === true) {
    const updatedArray = arrayAtPath(work.text, record.path);
    if (updatedArray !== undefined && updatedArray.items.length === 0) {
      const removed = removePathProperty(work.text, record.path);
      if (removed !== undefined) {
        work.text = removed;
      }
    }
  }
};

const removeStaleHookRecord = (
  work: MergeWork,
  record: HookOwnershipRecord,
  backupPath: string,
): void => {
  if (!recordIsOwned(record)) {
    return;
  }

  const matches = findHookMatches(work.text, record.scriptName, (match) => sameHookArguments(match, record.scriptName, record.value));
  const recorded = findRecordedHook(work.text, record);
  if (matches.length === 0) {
    if (recorded === undefined) {
      return;
    }
    const unchanged = jsonValuesEqual(recorded.value, record.value);
    if (!unchanged) {
      addBackupValue(work.backupValues, record.id, hookMatchLocation(recorded), recorded.value);
      work.events.push({
        type: "setting-kept",
        level: "warn",
        text: "Rig удалил изменённый хук \"" + record.id + "\"; значение сохранено в копии: " + backupPath,
      });
    }
    const removed = removeHookMatch(work.text, recorded);
    if (removed !== undefined) {
      work.text = removed;
    }
    return;
  }

  let chosen: HookMatch | undefined;
  if (recorded !== undefined && !hookMatchesIdentity(recorded.entryNode, record.scriptName)) {
    const observed: JsonValue = [makeHookChangeValue(recorded), ...matches.map((match) => makeHookChangeValue(match))];
    appendKeptEvent(work.events, record, recordChangeHash(record, observed), backupPath);
    return;
  }
  if (matches.length === 1) {
    chosen = matches[0];
  } else {
    const exactAtRecordedIndex = matches.filter((match) =>
      match.event === record.event
      && match.matcher === record.matcher
      && match.entryIndex === record.index
      && jsonValuesEqual(match.value, record.value));
    if (exactAtRecordedIndex.length === 1) {
      chosen = exactAtRecordedIndex[0];
    } else {
      const exactValueMatches = matches.filter((match) => jsonValuesEqual(match.value, record.value));
      if (exactValueMatches.length === 1) {
        chosen = exactValueMatches[0];
      }
    }
  }

  if (chosen === undefined) {
    const observed = matches.map((match) => makeHookChangeValue(match));
    const hash = recordChangeHash(record, observed);
    appendKeptEvent(work.events, record, hash, backupPath);
    return;
  }

  const unchanged = chosen.event === record.event
    && chosen.matcher === record.matcher
    && (record.groupIndex === undefined || chosen.groupIndex === record.groupIndex)
    && jsonValuesEqual(chosen.value, record.value);
  if (!unchanged) {
    addBackupValue(work.backupValues, record.id, hookMatchLocation(chosen), chosen.value);
    work.events.push({
      type: "setting-kept",
      level: "warn",
      text: "Rig удалил изменённый хук \"" + record.id + "\"; значение сохранено в копии: " + backupPath,
    });
  }

  const removed = removeHookMatch(work.text, chosen);
  if (removed !== undefined) {
    work.text = removed;
  }
};

const installDefault = (work: MergeWork, desired: DesiredInstallDefault, mode: "install" | "apply"): void => {
  if (mode !== "install") {
    return;
  }

  const document = parseSettingsDocument(work.text);
  if (!document.ok) {
    return;
  }
  const lookup = lookupPath(document.root, desired.path);
  if (lookup.kind !== "missing") {
    return;
  }
  const inserted = setPathValue(work.text, desired.path, desired.value);
  if (inserted !== undefined) {
    work.text = inserted;
  }
};

// A record's neighbour anchors (arrayLength, beforeValue, afterValue, index) describe the array as it
// ends up after the whole merge. An entry inserted later in the same merge can change them, so each
// output record is re-anchored against the final text. Records whose entry is not found exactly once
// are left as they are: they describe a conflict that the kept-event path already reported.
const anchorListRecord = (
  text: string,
  record: ListEntryOwnershipRecord,
  desired: DesiredListEntrySetting,
): ListEntryOwnershipRecord => {
  const document = parseSettingsDocument(text);
  if (!document.ok) {
    return record;
  }
  const lookup = lookupPath(document.root, record.path);
  if (lookup.kind !== "found" || lookup.property.value.kind !== "array") {
    return record;
  }
  const array = lookup.property.value;
  const indexes = valuesInArray(array, record.value);
  return indexes.length === 1
    ? makeListRecord(desired, array, indexes[0], record.containerCreated === true)
    : record;
};

const anchorHookRecord = (
  text: string,
  record: HookOwnershipRecord,
  desired: DesiredHookSetting,
): HookOwnershipRecord => {
  const matches = findHookMatches(text, record.scriptName).filter((match) =>
    match.event === record.event
    && match.matcher === record.matcher
    && jsonValuesEqual(match.value, record.value));
  return matches.length === 1 ? makeHookRecord(desired, matches[0]) : record;
};

const anchorOutputRecord = (
  text: string,
  record: SettingsOwnershipRecord,
  desired: DesiredSettingEntry | undefined,
): SettingsOwnershipRecord => {
  if (desired === undefined || !recordIsOwned(record)) {
    return record;
  }
  if (record.kind === "list-entry" && desired.kind === "list-entry") {
    return anchorListRecord(text, record, desired);
  }
  if (record.kind === "hook" && desired.kind === "hook") {
    return anchorHookRecord(text, record, desired);
  }
  return record;
};

const runMerge = (request: SettingsMergeRequest): SettingsMergeResult => {
  if (typeof request.currentText !== "string"
    || !isUnknownArray(request.desiredEntries)
    || !isUnknownArray(request.ownershipRecords)
    || (request.mode !== "install" && request.mode !== "apply")
    || typeof request.backupPath !== "string") {
    return { ok: false, error: "Invalid settings merge request" };
  }

  const parsedInitial = parseSettingsDocument(request.currentText);
  if (!parsedInitial.ok) {
    return { ok: false, error: parsedInitial.error };
  }

  const desiredEntries: DesiredSettingEntry[] = [];
  const desiredById = new Map<string, DesiredSettingEntry>();
  for (const entry of request.desiredEntries) {
    if (!isDesiredSetting(entry) || entry.id.trim().length === 0) {
      return { ok: false, error: "Invalid desired settings entry" };
    }
    if (desiredById.has(entry.id)) {
      return { ok: false, error: "Duplicate desired settings entry id: " + entry.id };
    }
    desiredEntries.push(entry);
    desiredById.set(entry.id, entry);
  }

  const previousRecords: SettingsOwnershipRecord[] = [];
  const previousById = new Map<string, SettingsOwnershipRecord>();
  for (const rawRecord of request.ownershipRecords) {
    const record = normalizeOwnershipRecord(rawRecord);
    if (record === undefined) {
      return { ok: false, error: "Invalid settings ownership record" };
    }
    if (previousById.has(record.id)) {
      return { ok: false, error: "Duplicate settings ownership record id: " + record.id };
    }
    previousRecords.push(record);
    previousById.set(record.id, record);
  }

  const work: MergeWork = {
    text: request.currentText,
    events: [],
    backupValues: [],
  };

  for (const record of previousRecords) {
    const desired = desiredById.get(record.id);
    if (desired === undefined || !recordKindMatchesDesired(record, desired)) {
      if (desired?.kind === "install-default") {
        continue;
      }
      if (record.kind === "value") {
        removeStaleValueRecord(work, record, request.backupPath);
      } else if (record.kind === "list-entry") {
        removeStaleListRecord(work, record, request.backupPath);
      } else {
        removeStaleHookRecord(work, record, request.backupPath);
      }
    }
  }

  const outputRecords: SettingsOwnershipRecord[] = [];
  for (const desired of desiredEntries) {
    if (desired.kind === "install-default") {
      installDefault(work, desired, request.mode);
      continue;
    }

    const candidate = previousById.get(desired.id);
    const previous = candidate !== undefined && recordKindMatchesDesired(candidate, desired)
      ? candidate
      : undefined;

    if (desired.kind === "value") {
      outputRecords.push(processValueSetting(
        work,
        desired,
        previous?.kind === "value" ? previous : undefined,
        request.backupPath,
      ));
    } else if (desired.kind === "list-entry") {
      const record = processListEntry(
        work,
        desired,
        previous?.kind === "list-entry" ? previous : undefined,
        request.backupPath,
      );
      if (record !== undefined) {
        outputRecords.push(record);
      }
    } else {
      const record = processHookSetting(
        work,
        desired,
        previous?.kind === "hook" ? previous : undefined,
        request.backupPath,
        desiredEntries.filter((entry): entry is DesiredHookSetting => entry.kind === "hook" && entry.id !== desired.id),
      );
      if (record !== undefined) {
        outputRecords.push(record);
      }
    }
  }

  const parsedFinal = parseSettingsDocument(work.text);
  if (!parsedFinal.ok) {
    return { ok: false, error: "Settings merge produced invalid JSON: " + parsedFinal.error };
  }

  const anchoredRecords = outputRecords.map((record) =>
    anchorOutputRecord(work.text, record, desiredById.get(record.id)));

  return {
    ok: true,
    text: work.text,
    records: anchoredRecords,
    events: work.events,
    backupValues: work.backupValues,
    changed: work.text !== request.currentText,
  };
};

export const mergeSettings = (request: SettingsMergeRequest): SettingsMergeResult => {
  try {
    return runMerge(request);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "unexpected error";
    return { ok: false, error: "Settings merge failed: " + detail };
  }
};
