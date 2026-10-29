import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const commands = fs.readFileSync(path.join(repoRoot, "Assets/Editor/HertzStudio/HertzStudioCharacterCommands.cs"), "utf8");
const bridge = fs.readFileSync(path.join(repoRoot, "Assets/Editor/HertzStudio/HertzStudioHttpBridge.cs"), "utf8");

test("managed character deployment uses shared scene identity and protects XR hierarchy", () => {
  assert.match(bridge, /path == "\/characters\/deploy"/);
  assert.match(bridge, /AssetDatabase\.AssetPathToGUID\(scenePath\)/);
  assert.match(bridge, /Scene revision mismatch/);
  assert.match(commands, /IsProtectedHierarchy\(candidate\)/);
  assert.match(commands, /GlobalObjectId\.GetGlobalObjectIdSlow\(managed\[i\]\)/);
  assert.doesNotMatch(commands, /HertzCharacterTest\.unity/);
  assert.doesNotMatch(commands, /SampleScene/);
});
test("repeat deployment keeps index zero stable and removes surplus managed roots", () => {
  assert.match(commands, /var expectedName = index == 0 \? baseName : \$"\{baseName\}_\{index\}"/);
  assert.match(commands, /TryGetManagedRootIndex\(candidate\.name, baseName, out _\)/);
  assert.match(commands, /Array\.IndexOf\(managed, candidate\) < 0/);
  assert.ok(commands.includes("UnityEditor.Undo.DestroyObjectImmediate(candidate)"));
});
test("managed character deployment rolls back its Unity mutation group on failure", () => {
  assert.ok(commands.includes("UnityEditor.Undo.RegisterFullObjectHierarchyUndo(root"));
  assert.ok(commands.includes("UnityEditor.Undo.RegisterCreatedObjectUndo(root"));
  assert.ok(commands.includes("UnityEditor.Undo.DestroyObjectImmediate(candidate)"));
  assert.ok(commands.includes("UnityEditor.Undo.RevertAllDownToGroup(undoGroup)"));
  assert.ok(commands.includes("changes were rolled back"));
});
