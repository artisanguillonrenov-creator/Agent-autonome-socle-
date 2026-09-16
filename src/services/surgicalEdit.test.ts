import test from "node:test";
import assert from "node:assert/strict";
import { applySurgicalEdit, SurgicalEditError } from "./surgicalEdit.js";

test("applySurgicalEdit remplace une occurrence unique", () => {
  const result = applySurgicalEdit("function old() { return 1; }", { oldString: "return 1;", newString: "return 2;" });
  assert.equal(result, "function old() { return 2; }");
});

test("applySurgicalEdit préserve le reste du fichier inchangé", () => {
  const original = "line1\nline2\nline3\n";
  const result = applySurgicalEdit(original, { oldString: "line2", newString: "replaced" });
  assert.equal(result, "line1\nreplaced\nline3\n");
});

test("applySurgicalEdit rejette un oldString absent du fichier (SURGICAL_EDIT_OLD_STRING_NOT_FOUND)", () => {
  assert.throws(
    () => applySurgicalEdit("hello world", { oldString: "goodbye", newString: "hi" }),
    (err: unknown) => err instanceof SurgicalEditError && err.code === "SURGICAL_EDIT_OLD_STRING_NOT_FOUND",
  );
});

test("applySurgicalEdit rejette un oldString ambigu (plusieurs occurrences) plutôt que de remplacer au hasard (SURGICAL_EDIT_OLD_STRING_NOT_UNIQUE)", () => {
  assert.throws(
    () => applySurgicalEdit("foo\nfoo\nfoo", { oldString: "foo", newString: "bar" }),
    (err: unknown) => err instanceof SurgicalEditError && err.code === "SURGICAL_EDIT_OLD_STRING_NOT_UNIQUE" && /3 fois/.test(err.message),
  );
});

test("applySurgicalEdit rejette un oldString vide (SURGICAL_EDIT_OLD_STRING_REQUIRED)", () => {
  assert.throws(
    () => applySurgicalEdit("hello", { oldString: "", newString: "hi" }),
    (err: unknown) => err instanceof SurgicalEditError && err.code === "SURGICAL_EDIT_OLD_STRING_REQUIRED",
  );
});

test("applySurgicalEdit rejette un no-op (oldString === newString) plutôt que de prétendre avoir modifié le fichier (SURGICAL_EDIT_NO_OP)", () => {
  assert.throws(
    () => applySurgicalEdit("hello world", { oldString: "hello", newString: "hello" }),
    (err: unknown) => err instanceof SurgicalEditError && err.code === "SURGICAL_EDIT_NO_OP",
  );
});

test("applySurgicalEdit autorise une suppression (newString vide)", () => {
  const result = applySurgicalEdit("keep this, remove this, keep this too", { oldString: "remove this, ", newString: "" });
  assert.equal(result, "keep this, keep this too");
});

test("applySurgicalEdit gère un remplacement multi-lignes", () => {
  const original = "function broken() {\n  return undefined;\n}\n";
  const result = applySurgicalEdit(original, { oldString: "function broken() {\n  return undefined;\n}", newString: "function fixed() {\n  return 42;\n}" });
  assert.equal(result, "function fixed() {\n  return 42;\n}\n");
});
